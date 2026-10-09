import type { Pool, PoolClient } from "pg";
import { z } from "zod";

import {
  clientVersionMaximumLength,
  clientVersionMinimumLength,
  clientVersionSemver2PatternSource,
} from "../features/session/client-version.js";
import {
  DeviceSessionCallerInvalidError,
  DeviceSessionIdempotencyConflictError,
  DeviceSessionRateLimitedError,
  type BootstrapVerifiedPrivyUserResult,
  type CreatedDeviceSession,
  type DeviceSession,
  type DeviceSessionRepository,
} from "../features/session/device-session-repository.js";
import { getOrCreateLoopUserInTransaction } from "./loop-user-insert.js";

const canonicalUuidPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const canonicalUuidV4Pattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const maximumSessionsPerOwnerPerDay = 20;
const maximumSessionsPerDevicePerDay = 5;
const maximumLogoutCommandsPerOwnerPerDay = 40;
const maximumLogoutCommandsPerSessionPerDay = 5;

const uuidSchema = z.string().regex(canonicalUuidPattern);
const uuidV4Schema = z.string().regex(canonicalUuidV4Pattern);
const privyUserIdSchema = z.string().min(1).max(255);
const sha256Schema = z.string().regex(/^[0-9a-f]{64}$/);
const clientVersionSchema = z
  .string()
  .min(clientVersionMinimumLength)
  .max(clientVersionMaximumLength)
  .regex(new RegExp(clientVersionSemver2PatternSource));
const validDateSchema = z
  .instanceof(Date)
  .refine((value) => !Number.isNaN(value.getTime()));
const rowSchema = z
  .object({
    session_id: uuidSchema,
    owner_user_id: uuidSchema,
    device_id: uuidV4Schema,
    client_platform: z.enum(["android", "ios"]),
    client_version: clientVersionSchema,
    bootstrap_digest_version: z.literal("device_session_bootstrap_v1"),
    contract_version: z.literal("2.0"),
    auth_strength: z.literal("provider_authenticated"),
    policy_version: z.literal("session_policy_v1"),
    status: z.enum(["active", "revoked"]),
    created_at: validDateSchema,
    last_seen_at: validDateSchema,
    revoked_at: validDateSchema.nullable(),
  })
  .strict();
const commandKindSchema = z.enum(["logout", "revoke"]);
const commandDigestVersions = Object.freeze({
  logout: "device_session_logout_v1",
  revoke: "device_session_revoke_v1",
} as const);
const commandRowSchema = z
  .object({
    owner_user_id: uuidSchema,
    requested_session_id: uuidSchema,
    resolved_session_id: uuidSchema.nullable(),
    request_digest_version: z.enum([
      commandDigestVersions.logout,
      commandDigestVersions.revoke,
    ]),
    request_sha256: sha256Schema,
    result_status: z.enum(["not_found", "revoked"]),
    result_revoked_at: validDateSchema.nullable(),
  })
  .strict();
const bootstrapReplayRowSchema = z
  .object({
    session_id: uuidSchema,
    owner_user_id: uuidSchema,
    bootstrap_digest_version: z.literal("device_session_bootstrap_v1"),
    bootstrap_request_sha256: sha256Schema,
    device_id: uuidV4Schema,
    client_platform: z.enum(["android", "ios"]),
    client_version: clientVersionSchema,
  })
  .strict();
const sessionCapacityRowSchema = z
  .object({
    owner_day_count: z.coerce.number().int().nonnegative(),
    device_day_count: z.coerce.number().int().nonnegative(),
  })
  .strict();
const logoutCommandCapacityRowSchema = z
  .object({
    owner_day_count: z.coerce.number().int().nonnegative(),
    session_day_count: z.coerce.number().int().nonnegative(),
  })
  .strict();

const createInputSchema = z
  .object({
    ownerUserId: uuidSchema,
    idempotencyKey: uuidV4Schema,
    requestSha256: sha256Schema,
    requestId: uuidV4Schema,
    deviceId: uuidV4Schema,
    clientPlatform: z.enum(["android", "ios"]),
    clientVersion: clientVersionSchema,
  })
  .strict();
const bootstrapVerifiedPrivyUserInputSchema = createInputSchema
  .omit({ ownerUserId: true })
  .extend({ privyUserId: privyUserIdSchema })
  .strict();
const revokeInputSchema = z
  .object({
    ownerUserId: uuidSchema,
    sessionId: uuidSchema,
    idempotencyKey: uuidV4Schema,
    requestSha256: sha256Schema,
    requestId: uuidV4Schema,
    commandKind: commandKindSchema.default("logout"),
    callerSessionId: uuidSchema.optional(),
  })
  .strict();
const listLimitSchema = z.number().int().min(1).max(500);

const returningColumns = `
  session_id,
  owner_user_id,
  device_id,
  client_platform,
  client_version,
  bootstrap_digest_version,
  contract_version,
  auth_strength,
  policy_version,
  status,
  created_at,
  last_seen_at,
  revoked_at
`;

function toDeviceSession(raw: unknown): DeviceSession {
  const row = rowSchema.parse(raw);
  return Object.freeze({
    sessionId: row.session_id,
    ownerUserId: row.owner_user_id,
    deviceId: row.device_id,
    clientPlatform: row.client_platform,
    clientVersion: row.client_version,
    authStrength: "providerAuthenticated" as const,
    policyVersion: "sessionPolicyV1" as const,
    status: row.status,
    createdAt: row.created_at.toISOString(),
    lastSeenAt: row.last_seen_at.toISOString(),
    revokedAt: row.revoked_at?.toISOString() ?? null,
  });
}

function toCreatedDeviceSession(session: DeviceSession): CreatedDeviceSession {
  return Object.freeze({
    ...session,
    status: "active",
    lastSeenAt: session.createdAt,
    revokedAt: null,
  });
}

function assertBootstrapReplayMatches(
  raw: unknown,
  input: z.infer<typeof createInputSchema>,
): string {
  const replay = bootstrapReplayRowSchema.parse(raw);
  if (
    replay.owner_user_id !== input.ownerUserId ||
    replay.bootstrap_request_sha256 !== input.requestSha256 ||
    replay.device_id !== input.deviceId ||
    replay.client_platform !== input.clientPlatform ||
    replay.client_version !== input.clientVersion
  ) {
    throw new DeviceSessionIdempotencyConflictError();
  }
  return replay.session_id;
}

async function withTransaction<T>(
  pool: Pool,
  operation: (client: PoolClient) => Promise<T>,
): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query("begin");
    const result = await operation(client);
    await client.query("commit");
    return result;
  } catch (error) {
    await client.query("rollback");
    throw error;
  } finally {
    client.release();
  }
}

async function findSession(
  client: Pick<Pool, "query">,
  ownerUserId: string,
  sessionId: string,
): Promise<DeviceSession | null> {
  const result = await client.query<Record<string, unknown>>({
    text: `
      select ${returningColumns}
      from public.device_sessions
      where owner_user_id = $1 and session_id = $2
      limit 1
    `,
    values: [ownerUserId, sessionId],
  });
  const row = result.rows[0];
  return row === undefined ? null : toDeviceSession(row);
}

async function resolveReplayedCommand(
  client: PoolClient,
  input: {
    readonly ownerUserId: string;
    readonly sessionId: string;
    readonly requestSha256: string;
    readonly commandKind: "logout" | "revoke";
  },
  rawCommand: unknown,
): Promise<DeviceSession | null> {
  const command = commandRowSchema.parse(rawCommand);
  if (
    command.owner_user_id !== input.ownerUserId ||
    command.requested_session_id !== input.sessionId ||
    command.request_sha256 !== input.requestSha256 ||
    command.request_digest_version !== commandDigestVersions[input.commandKind]
  ) {
    throw new DeviceSessionIdempotencyConflictError();
  }

  if (command.result_status === "not_found") {
    if (
      command.resolved_session_id !== null ||
      command.result_revoked_at !== null
    ) {
      throw new Error("Invalid not-found device-session command result");
    }
    return null;
  }

  if (
    command.resolved_session_id !== input.sessionId ||
    command.result_revoked_at === null
  ) {
    throw new Error("Invalid revoked device-session command result");
  }
  const session = await findSession(client, input.ownerUserId, input.sessionId);
  if (session === null || session.status !== "revoked") {
    throw new Error("Revoked device-session command lost its session");
  }
  return Object.freeze({
    ...session,
    revokedAt: command.result_revoked_at.toISOString(),
  });
}

async function createSessionInTransaction(
  client: PoolClient,
  input: z.infer<typeof createInputSchema>,
): Promise<CreatedDeviceSession> {
  await client.query({
    text: `
      select pg_advisory_xact_lock(
        hashtextextended('loop:v2:device-session:bootstrap:' || $1, 0)
      )
    `,
    values: [input.idempotencyKey],
  });

  const existing = await client.query<Record<string, unknown>>({
    text: `
      select
        session_id,
        owner_user_id,
        bootstrap_digest_version,
        bootstrap_request_sha256,
        device_id,
        client_platform,
        client_version
      from public.device_sessions
      where bootstrap_idempotency_key = $1
      for update
    `,
    values: [input.idempotencyKey],
  });
  if (existing.rows[0] !== undefined) {
    const replaySessionId = assertBootstrapReplayMatches(
      existing.rows[0],
      input,
    );
    const replayed = await findSession(
      client,
      input.ownerUserId,
      replaySessionId,
    );
    if (replayed === null) {
      throw new Error("Bootstrap result lost its device session");
    }
    return toCreatedDeviceSession(replayed);
  }

  await client.query({
    text: `
      select pg_advisory_xact_lock(
        hashtextextended('loop:v2:device-session:owner:' || $1, 0)
      )
    `,
    values: [input.ownerUserId],
  });
  const capacityResult = await client.query<Record<string, unknown>>({
    text: `
      select
        count(*) filter (
          where created_at >= clock_timestamp() - interval '24 hours'
        ) as owner_day_count,
        count(*) filter (
          where device_id = $2
            and created_at >= clock_timestamp() - interval '24 hours'
        ) as device_day_count
      from public.device_sessions
      where owner_user_id = $1
    `,
    values: [input.ownerUserId, input.deviceId],
  });
  const capacity = sessionCapacityRowSchema.parse(capacityResult.rows[0]);
  if (
    capacity.owner_day_count >= maximumSessionsPerOwnerPerDay ||
    capacity.device_day_count >= maximumSessionsPerDevicePerDay
  ) {
    throw new DeviceSessionRateLimitedError();
  }

  const result = await client.query<Record<string, unknown>>({
    text: `
      with command_time as (
        select clock_timestamp() as occurred_at
      )
      insert into public.device_sessions (
        owner_user_id,
        bootstrap_idempotency_key,
        bootstrap_digest_version,
        bootstrap_request_sha256,
        device_id,
        client_platform,
        client_version,
        created_at,
        last_seen_at
      )
      select
        $1,
        $2,
        'device_session_bootstrap_v1',
        $3,
        $4,
        $5,
        $6,
        occurred_at,
        occurred_at
      from command_time
      returning ${returningColumns}
    `,
    values: [
      input.ownerUserId,
      input.idempotencyKey,
      input.requestSha256,
      input.deviceId,
      input.clientPlatform,
      input.clientVersion,
    ],
  });
  const row = result.rows[0];
  if (row === undefined) {
    throw new Error("Device session insert returned no result");
  }
  const session = toCreatedDeviceSession(toDeviceSession(row));
  await client.query({
    text: `
      insert into public.device_session_events (
        owner_user_id,
        session_id,
        event_version,
        event_type,
        request_id
      )
      values ($1, $2, 0, 'session_created', $3)
      on conflict (session_id, event_version) do nothing
    `,
    values: [session.ownerUserId, session.sessionId, input.requestId],
  });
  return session;
}

export interface PostgresDeviceSessionRepositoryOptions {
  /** Test seam for LOOP ID allocation; production uses the crypto generator. */
  readonly generateLoopId?: () => string;
}

export function createPostgresDeviceSessionRepository(
  pool: Pool,
  options: PostgresDeviceSessionRepositoryOptions = {},
): DeviceSessionRepository {
  const loopUserOptions =
    options.generateLoopId === undefined
      ? {}
      : { generateLoopId: options.generateLoopId };
  return {
    async bootstrapVerifiedPrivyUser(rawInput) {
      const input = bootstrapVerifiedPrivyUserInputSchema.parse(rawInput);
      return withTransaction(
        pool,
        async (client): Promise<BootstrapVerifiedPrivyUserResult> => {
          const account = await getOrCreateLoopUserInTransaction(
            client,
            input.privyUserId,
            loopUserOptions,
          );
          const session = await createSessionInTransaction(client, {
            ownerUserId: account.id,
            idempotencyKey: input.idempotencyKey,
            requestSha256: input.requestSha256,
            requestId: input.requestId,
            deviceId: input.deviceId,
            clientPlatform: input.clientPlatform,
            clientVersion: input.clientVersion,
          });
          return Object.freeze({ account, session });
        },
      );
    },

    async create(rawInput) {
      const input = createInputSchema.parse(rawInput);
      return withTransaction(pool, (client) =>
        createSessionInTransaction(client, input),
      );
    },

    async findById(rawOwnerUserId, rawSessionId) {
      const ownerUserId = uuidSchema.parse(rawOwnerUserId);
      const sessionId = uuidSchema.parse(rawSessionId);
      return findSession(pool, ownerUserId, sessionId);
    },

    async listByOwner(rawOwnerUserId, rawLimit) {
      const ownerUserId = uuidSchema.parse(rawOwnerUserId);
      const limit = listLimitSchema.parse(rawLimit);
      const result = await pool.query<Record<string, unknown>>({
        text: `
          select ${returningColumns}
          from public.device_sessions
          where owner_user_id = $1
          order by
            (status = 'active') desc,
            created_at desc,
            session_id desc
          limit $2
        `,
        values: [ownerUserId, limit],
      });
      return Object.freeze(result.rows.map(toDeviceSession));
    },

    async revoke(rawInput) {
      const input = revokeInputSchema.parse(rawInput);
      const digestVersion = commandDigestVersions[input.commandKind];
      return withTransaction(pool, async (client) => {
        await client.query({
          text: `
            select pg_advisory_xact_lock(
              hashtextextended('loop:v2:device-session:' || $2 || ':' || $1, 0)
            )
          `,
          values: [input.idempotencyKey, input.commandKind],
        });

        const existingCommand = await client.query<Record<string, unknown>>({
          text: `
            select
              owner_user_id,
              requested_session_id,
              resolved_session_id,
              request_digest_version,
              request_sha256,
              result_status,
              result_revoked_at
            from public.device_session_commands
            where command_kind = $2 and idempotency_key = $1
            for update
          `,
          values: [input.idempotencyKey, input.commandKind],
        });
        if (existingCommand.rows[0] !== undefined) {
          return resolveReplayedCommand(client, input, existingCommand.rows[0]);
        }

        if (input.commandKind === "revoke") {
          // The caller's session is re-read under the same transaction: a
          // revoked or foreign caller cannot revoke anybody else.
          if (input.callerSessionId === undefined) {
            throw new DeviceSessionCallerInvalidError();
          }
          const caller = await findSession(
            client,
            input.ownerUserId,
            input.callerSessionId,
          );
          if (caller === null || caller.status !== "active") {
            throw new DeviceSessionCallerInvalidError();
          }
        }

        await client.query({
          text: `
            select pg_advisory_xact_lock(
              hashtextextended(
                'loop:v2:device-session:logout-owner:' || $1,
                0
              )
            )
          `,
          values: [input.ownerUserId],
        });
        const commandCapacityResult = await client.query<
          Record<string, unknown>
        >({
          text: `
            select
              count(*) filter (
                where created_at >= clock_timestamp() - interval '24 hours'
              ) as owner_day_count,
              count(*) filter (
                where requested_session_id = $2
                  and created_at >= clock_timestamp() - interval '24 hours'
              ) as session_day_count
            from public.device_session_commands
            where owner_user_id = $1
          `,
          values: [input.ownerUserId, input.sessionId],
        });
        const commandCapacity = logoutCommandCapacityRowSchema.parse(
          commandCapacityResult.rows[0],
        );
        if (
          commandCapacity.owner_day_count >=
            maximumLogoutCommandsPerOwnerPerDay ||
          commandCapacity.session_day_count >=
            maximumLogoutCommandsPerSessionPerDay
        ) {
          throw new DeviceSessionRateLimitedError();
        }

        const locked = await client.query<Record<string, unknown>>({
          text: `
            select ${returningColumns}
            from public.device_sessions
            where owner_user_id = $1 and session_id = $2
            for update
          `,
          values: [input.ownerUserId, input.sessionId],
        });
        const lockedRow = locked.rows[0];
        if (lockedRow === undefined) {
          await client.query({
            text: `
              insert into public.device_session_commands (
                owner_user_id,
                requested_session_id,
                resolved_session_id,
                command_kind,
                idempotency_key,
                request_digest_version,
                request_sha256,
                request_id,
                result_status,
                result_revoked_at
              )
              values (
                $1,
                $2,
                null,
                $6,
                $3,
                $7,
                $4,
                $5,
                'not_found',
                null
              )
            `,
            values: [
              input.ownerUserId,
              input.sessionId,
              input.idempotencyKey,
              input.requestSha256,
              input.requestId,
              input.commandKind,
              digestVersion,
            ],
          });
          return null;
        }

        const updated = await client.query<Record<string, unknown>>({
          text: `
            update public.device_sessions
            set status = 'revoked', revoked_at = clock_timestamp()
            where owner_user_id = $1
              and session_id = $2
              and status = 'active'
            returning ${returningColumns}
          `,
          values: [input.ownerUserId, input.sessionId],
        });
        const session =
          updated.rows[0] === undefined
            ? toDeviceSession(lockedRow)
            : toDeviceSession(updated.rows[0]);

        if (session.status !== "revoked" || session.revokedAt === null) {
          throw new Error(
            "Device session revocation did not reach a terminal state",
          );
        }

        // Decision 0067: a session that is gone must stop being a delivery
        // address. Logout and remote revoke share this transaction, so the
        // push token is retired by the same commit that retires the session.
        await client.query({
          text: `
            update public.device_push_tokens
            set status = 'revoked',
                revoked_at = clock_timestamp(),
                revoke_reason = 'session_revoked'
            where session_id = $1 and status = 'active'
          `,
          values: [session.sessionId],
        });

        await client.query({
          text: `
            insert into public.device_session_commands (
              owner_user_id,
              requested_session_id,
              resolved_session_id,
              command_kind,
              idempotency_key,
              request_digest_version,
              request_sha256,
              request_id,
              result_status,
              result_revoked_at
            )
            values (
              $1,
              $2,
              $2,
              $7,
              $3,
              $8,
              $4,
              $5,
              'revoked',
              $6
            )
          `,
          values: [
            input.ownerUserId,
            input.sessionId,
            input.idempotencyKey,
            input.requestSha256,
            input.requestId,
            session.revokedAt,
            input.commandKind,
            digestVersion,
          ],
        });

        if (updated.rows[0] !== undefined) {
          await client.query({
            text: `
              insert into public.device_session_events (
                owner_user_id,
                session_id,
                event_version,
                event_type,
                request_id
              )
              values ($1, $2, 1, 'session_revoked', $3)
            `,
            values: [session.ownerUserId, session.sessionId, input.requestId],
          });
        }
        return session;
      });
    },
  };
}
