import { createHash } from "node:crypto";

import type { Pool, PoolClient } from "pg";
import { z } from "zod";

import { optionalNotificationCategories } from "../features/alerts/notification-contract.js";
import {
  pushEventTypes,
  pushPlatforms,
  pushTokenMaximumLength,
  pushTokenMinimumLength,
  pushTokenRevokeReasons,
} from "../features/push/push-contract.js";
import {
  PushIdempotencyConflictError,
  PushSessionInvalidError,
  type CompleteDeliveryInput,
  type ListCommunityTargetsInput,
  type ListOwnerTargetsInput,
  type PushDeliveryTarget,
  type PushRepository,
  type PushTokenRecord,
  type RegisterPushTokenInput,
  type RegisterPushTokenResult,
  type ReserveDeliveryInput,
  type ReserveDeliveryResult,
  type UnregisterPushTokenInput,
  type UnregisterPushTokenResult,
} from "../features/push/push-repository.js";

/**
 * PostgreSQL push channel repository (Decision 0067).
 *
 * Registration is a transaction that revokes whatever active row the session
 * or the token had and inserts the new one, so the two partial unique indexes
 * can never be violated by a device that reinstalled, signed in again, or
 * moved its token between sessions. Delivery reservation takes the
 * at-most-once slot and the hourly budget together: a row that exists is a
 * slot that was spent.
 */

const uuidSchema = z.string().uuid();
const sha256Schema = z.string().regex(/^[0-9a-f]{64}$/);
const dateSchema = z
  .instanceof(Date)
  .refine((value) => !Number.isNaN(value.getTime()));

export const pushTokenRegisterDigestVersion =
  "device_push_token_register_v1" as const;
export const pushTokenUnregisterDigestVersion =
  "device_push_token_unregister_v1" as const;

const tokenRowSchema = z
  .object({
    push_token_id: uuidSchema,
    owner_user_id: uuidSchema,
    session_id: uuidSchema,
    device_id: uuidSchema,
    platform: z.enum(pushPlatforms),
    token_sha256: sha256Schema,
    app_version: z.string().min(5).max(64),
    status: z.enum(["active", "revoked"]),
    registered_at: dateSchema,
    last_observed_at: dateSchema,
    revoked_at: dateSchema.nullable(),
  })
  .strict();

const targetRowSchema = z
  .object({
    push_token_id: uuidSchema,
    owner_user_id: uuidSchema,
    platform: z.enum(pushPlatforms),
    token_sha256: sha256Schema,
    token: z.string().min(pushTokenMinimumLength).max(pushTokenMaximumLength),
  })
  .strict();

const commandRowSchema = z
  .object({
    owner_user_id: uuidSchema,
    session_id: uuidSchema,
    request_sha256: sha256Schema,
    result_status: z.enum(["registered", "unregistered", "not_registered"]),
    result_push_token_id: uuidSchema.nullable(),
  })
  .strict();

const registerInputSchema = z
  .object({
    ownerUserId: uuidSchema,
    sessionId: uuidSchema,
    deviceId: uuidSchema,
    platform: z.enum(pushPlatforms),
    token: z.string().min(pushTokenMinimumLength).max(pushTokenMaximumLength),
    appVersion: z.string().min(5).max(64),
    idempotencyKey: uuidSchema,
    requestSha256: sha256Schema,
    requestId: uuidSchema,
  })
  .strict();

const unregisterInputSchema = z
  .object({
    ownerUserId: uuidSchema,
    sessionId: uuidSchema,
    idempotencyKey: uuidSchema,
    requestSha256: sha256Schema,
    requestId: uuidSchema,
  })
  .strict();

const categoryGateSchema = z
  .object({
    category: z.enum(optionalNotificationCategories),
    defaultEnabled: z.boolean(),
  })
  .strict()
  .nullable();

const ownerTargetsInputSchema = z
  .object({
    ownerUserId: uuidSchema,
    categoryGate: categoryGateSchema,
    limit: z.number().int().min(1).max(100),
  })
  .strict();

const communityTargetsInputSchema = z
  .object({
    communityId: uuidSchema,
    excludeOwnerUserId: uuidSchema.nullable(),
    categoryGate: categoryGateSchema,
    limit: z.number().int().min(1).max(1_000),
  })
  .strict();

const reserveInputSchema = z
  .object({
    ownerUserId: uuidSchema,
    pushTokenId: uuidSchema,
    eventType: z.enum(pushEventTypes),
    eventKey: z.string().min(1).max(200),
    mandatory: z.boolean(),
    windowSeconds: z.number().int().min(1).max(86_400),
    limit: z.number().int().min(1).max(1_000),
  })
  .strict();

const completeInputSchema = z
  .object({
    deliveryId: uuidSchema,
    status: z.enum(["sent", "invalid_token", "failed"]),
    reasonCode: z
      .string()
      .regex(/^[A-Z][A-Z0-9_]{2,63}$/)
      .nullable(),
    providerMessageRef: z.string().min(1).max(200).nullable(),
  })
  .strict();

const revokeInputSchema = z
  .object({
    pushTokenId: uuidSchema,
    reason: z.enum(pushTokenRevokeReasons),
  })
  .strict();

const tokenColumns = `
  push_token_id,
  owner_user_id,
  session_id,
  device_id,
  platform,
  token_sha256,
  app_version,
  status,
  registered_at,
  last_observed_at,
  revoked_at
`;

export function pushTokenDigest(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

function toTokenRecord(raw: unknown): PushTokenRecord {
  const row = tokenRowSchema.parse(raw);
  return Object.freeze({
    pushTokenId: row.push_token_id,
    ownerUserId: row.owner_user_id,
    sessionId: row.session_id,
    deviceId: row.device_id,
    platform: row.platform,
    tokenSha256: row.token_sha256,
    appVersion: row.app_version,
    status: row.status,
    registeredAt: row.registered_at.toISOString(),
    lastObservedAt: row.last_observed_at.toISOString(),
    revokedAt: row.revoked_at?.toISOString() ?? null,
  });
}

function toTarget(raw: unknown): PushDeliveryTarget {
  const row = targetRowSchema.parse(raw);
  return Object.freeze({
    pushTokenId: row.push_token_id,
    ownerUserId: row.owner_user_id,
    platform: row.platform,
    tokenSha256: row.token_sha256,
    token: row.token,
  });
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

async function readToken(
  client: PoolClient,
  pushTokenId: string,
): Promise<PushTokenRecord> {
  const result = await client.query<Record<string, unknown>>({
    text: `select ${tokenColumns} from public.device_push_tokens where push_token_id = $1`,
    values: [pushTokenId],
  });
  if (result.rows[0] === undefined) {
    throw new Error("The replayed push token command lost its token row");
  }
  return toTokenRecord(result.rows[0]);
}

/**
 * The gate SQL. A mandatory event has no gate. An optional event consults
 * `notification_preferences_v2`, falling back to the product default when the
 * owner never wrote preferences — the same rule
 * `NotificationRepository.isCategoryEnabled` applies.
 */
function categoryGateClause(
  gate: { readonly category: string; readonly defaultEnabled: boolean } | null,
  tokenAlias: string,
  categoryParam: string,
  defaultParam: string,
): string {
  if (gate === null) {
    return "true";
  }
  return `coalesce((
      select preference.enabled
      from public.notification_preferences_v2 as preference
      where preference.owner_user_id = ${tokenAlias}.owner_user_id
        and preference.category = ${categoryParam}::text
    ), ${defaultParam}::boolean)`;
}

/** Gate parameters are omitted entirely when the event is mandatory. */
function categoryGateValues(
  gate: { readonly category: string; readonly defaultEnabled: boolean } | null,
): readonly unknown[] {
  return gate === null ? [] : [gate.category, gate.defaultEnabled];
}

export function createPostgresPushRepository(pool: Pool): PushRepository {
  return Object.freeze({
    async registerToken(
      rawInput: RegisterPushTokenInput,
    ): Promise<RegisterPushTokenResult> {
      const input = registerInputSchema.parse(rawInput);
      const tokenSha256 = pushTokenDigest(input.token);
      return withTransaction(pool, async (client) => {
        await client.query({
          text: `
            select pg_advisory_xact_lock(
              hashtextextended(
                'loop:v2:push-token:register:' || $1,
                0
              )
            )
          `,
          values: [input.idempotencyKey],
        });

        const replay = await client.query<Record<string, unknown>>({
          text: `
            select
              owner_user_id,
              session_id,
              request_sha256,
              result_status,
              result_push_token_id
            from public.device_push_token_commands
            where command_kind = 'push_token_register'
              and idempotency_key = $1
            for update
          `,
          values: [input.idempotencyKey],
        });
        const replayRow = replay.rows[0];
        if (replayRow !== undefined) {
          const command = commandRowSchema.parse(replayRow);
          if (
            command.owner_user_id !== input.ownerUserId ||
            command.session_id !== input.sessionId ||
            command.request_sha256 !== input.requestSha256 ||
            command.result_push_token_id === null
          ) {
            throw new PushIdempotencyConflictError();
          }
          return Object.freeze({
            created: false,
            token: await readToken(client, command.result_push_token_id),
          });
        }

        // The session must be this owner's and still active: a revoked or
        // foreign session never gains a delivery address.
        const session = await client.query<Record<string, unknown>>({
          text: `
            select device_id, client_platform, status
            from public.device_sessions
            where owner_user_id = $1 and session_id = $2
            for update
          `,
          values: [input.ownerUserId, input.sessionId],
        });
        const sessionRow = z
          .object({
            device_id: uuidSchema,
            client_platform: z.enum(pushPlatforms),
            status: z.enum(["active", "revoked"]),
          })
          .strict()
          .safeParse(session.rows[0]);
        if (
          !sessionRow.success ||
          sessionRow.data.status !== "active" ||
          sessionRow.data.device_id !== input.deviceId ||
          sessionRow.data.client_platform !== input.platform
        ) {
          throw new PushSessionInvalidError();
        }

        // A session re-sending the token it already has keeps its row and
        // its `pushTokenId`; only the observation time and the app version
        // move. Anything else — a new token on this session, or this token
        // arriving from another session — retires the previous active rows
        // so the two partial unique indexes stay satisfiable.
        const refreshed = await client.query<Record<string, unknown>>({
          text: `
            update public.device_push_tokens
            set last_observed_at = clock_timestamp(),
                app_version = $3
            where session_id = $1
              and token_sha256 = $2
              and status = 'active'
            returning ${tokenColumns}
          `,
          values: [input.sessionId, tokenSha256, input.appVersion],
        });
        let created = false;
        let token: PushTokenRecord;
        if (refreshed.rows[0] !== undefined) {
          token = toTokenRecord(refreshed.rows[0]);
        } else {
          await client.query({
            text: `
              update public.device_push_tokens
              set status = 'revoked',
                  revoked_at = clock_timestamp(),
                  revoke_reason = 'replaced_by_session'
              where status = 'active'
                and (session_id = $1 or token_sha256 = $2)
            `,
            values: [input.sessionId, tokenSha256],
          });
          const inserted = await client.query<Record<string, unknown>>({
            text: `
              insert into public.device_push_tokens (
                owner_user_id,
                session_id,
                device_id,
                platform,
                token,
                token_sha256,
                app_version
              )
              values ($1, $2, $3, $4, $5, $6, $7)
              returning ${tokenColumns}
            `,
            values: [
              input.ownerUserId,
              input.sessionId,
              input.deviceId,
              input.platform,
              input.token,
              tokenSha256,
              input.appVersion,
            ],
          });
          token = toTokenRecord(inserted.rows[0]);
          created = true;
        }

        await client.query({
          text: `
            insert into public.device_push_token_commands (
              owner_user_id,
              session_id,
              command_kind,
              idempotency_key,
              request_digest_version,
              request_sha256,
              request_id,
              result_status,
              result_push_token_id
            )
            values ($1, $2, 'push_token_register', $3, $4, $5, $6, 'registered', $7)
          `,
          values: [
            input.ownerUserId,
            input.sessionId,
            input.idempotencyKey,
            pushTokenRegisterDigestVersion,
            input.requestSha256,
            input.requestId,
            token.pushTokenId,
          ],
        });
        return Object.freeze({ created, token });
      });
    },

    async unregisterToken(
      rawInput: UnregisterPushTokenInput,
    ): Promise<UnregisterPushTokenResult> {
      const input = unregisterInputSchema.parse(rawInput);
      return withTransaction(pool, async (client) => {
        await client.query({
          text: `
            select pg_advisory_xact_lock(
              hashtextextended(
                'loop:v2:push-token:unregister:' || $1,
                0
              )
            )
          `,
          values: [input.idempotencyKey],
        });
        const replay = await client.query<Record<string, unknown>>({
          text: `
            select
              owner_user_id,
              session_id,
              request_sha256,
              result_status,
              result_push_token_id
            from public.device_push_token_commands
            where command_kind = 'push_token_unregister'
              and idempotency_key = $1
            for update
          `,
          values: [input.idempotencyKey],
        });
        const replayRow = replay.rows[0];
        if (replayRow !== undefined) {
          const command = commandRowSchema.parse(replayRow);
          if (
            command.owner_user_id !== input.ownerUserId ||
            command.session_id !== input.sessionId ||
            command.request_sha256 !== input.requestSha256
          ) {
            throw new PushIdempotencyConflictError();
          }
          if (command.result_push_token_id === null) {
            return Object.freeze({ unregistered: false, revokedAt: null });
          }
          const token = await readToken(client, command.result_push_token_id);
          return Object.freeze({
            unregistered: true,
            revokedAt: token.revokedAt,
          });
        }

        const revoked = await client.query<Record<string, unknown>>({
          text: `
            update public.device_push_tokens
            set status = 'revoked',
                revoked_at = clock_timestamp(),
                revoke_reason = 'client_unregister'
            where owner_user_id = $1
              and session_id = $2
              and status = 'active'
            returning ${tokenColumns}
          `,
          values: [input.ownerUserId, input.sessionId],
        });
        const row = revoked.rows[0];
        const token = row === undefined ? null : toTokenRecord(row);
        await client.query({
          text: `
            insert into public.device_push_token_commands (
              owner_user_id,
              session_id,
              command_kind,
              idempotency_key,
              request_digest_version,
              request_sha256,
              request_id,
              result_status,
              result_push_token_id
            )
            values ($1, $2, 'push_token_unregister', $3, $4, $5, $6, $7, $8)
          `,
          values: [
            input.ownerUserId,
            input.sessionId,
            input.idempotencyKey,
            pushTokenUnregisterDigestVersion,
            input.requestSha256,
            input.requestId,
            token === null ? "not_registered" : "unregistered",
            token?.pushTokenId ?? null,
          ],
        });
        return Object.freeze({
          unregistered: token !== null,
          revokedAt: token?.revokedAt ?? null,
        });
      });
    },

    async findActiveTokenBySession(input: {
      readonly ownerUserId: string;
      readonly sessionId: string;
    }): Promise<PushTokenRecord | null> {
      const ownerUserId = uuidSchema.parse(input.ownerUserId);
      const sessionId = uuidSchema.parse(input.sessionId);
      const result = await pool.query<Record<string, unknown>>({
        text: `
          select ${tokenColumns}
          from public.device_push_tokens
          where owner_user_id = $1 and session_id = $2 and status = 'active'
        `,
        values: [ownerUserId, sessionId],
      });
      return result.rows[0] === undefined
        ? null
        : toTokenRecord(result.rows[0]);
    },

    async listOwnerTargets(
      rawInput: ListOwnerTargetsInput,
    ): Promise<readonly PushDeliveryTarget[]> {
      const input = ownerTargetsInputSchema.parse(rawInput);
      const gated = input.categoryGate !== null;
      const result = await pool.query<Record<string, unknown>>({
        text: `
          select
            token.push_token_id,
            token.owner_user_id,
            token.platform,
            token.token_sha256,
            token.token
          from public.device_push_tokens as token
          where token.owner_user_id = $1
            and token.status = 'active'
            and ${categoryGateClause(input.categoryGate, "token", "$2", "$3")}
          order by token.registered_at asc, token.push_token_id asc
          limit $${gated ? "4" : "2"}
        `,
        values: [
          input.ownerUserId,
          ...categoryGateValues(input.categoryGate),
          input.limit,
        ],
      });
      return Object.freeze(result.rows.map(toTarget));
    },

    async listCommunityTargets(
      rawInput: ListCommunityTargetsInput,
    ): Promise<readonly PushDeliveryTarget[]> {
      const input = communityTargetsInputSchema.parse(rawInput);
      const gated = input.categoryGate !== null;
      const result = await pool.query<Record<string, unknown>>({
        text: `
          select
            token.push_token_id,
            token.owner_user_id,
            token.platform,
            token.token_sha256,
            token.token
          from public.device_push_tokens as token
          join public.community_memberships as membership
            on membership.owner_user_id = token.owner_user_id
           and membership.community_id = $1
           and membership.status = 'active'
          where token.status = 'active'
            and ($2::uuid is null or token.owner_user_id <> $2::uuid)
            and ${categoryGateClause(input.categoryGate, "token", "$3", "$4")}
          order by membership.joined_at asc, token.push_token_id asc
          limit $${gated ? "5" : "3"}
        `,
        values: [
          input.communityId,
          input.excludeOwnerUserId,
          ...categoryGateValues(input.categoryGate),
          input.limit,
        ],
      });
      return Object.freeze(result.rows.map(toTarget));
    },

    async reserveDelivery(
      rawInput: ReserveDeliveryInput,
    ): Promise<ReserveDeliveryResult> {
      const input = reserveInputSchema.parse(rawInput);
      return withTransaction(pool, async (client) => {
        await client.query({
          text: `
            select pg_advisory_xact_lock(
              hashtextextended('loop:v2:push-delivery:' || $1, 0)
            )
          `,
          values: [input.pushTokenId],
        });
        const duplicate = await client.query({
          text: `
            select 1
            from public.push_deliveries
            where push_token_id = $1 and event_key = $2
          `,
          values: [input.pushTokenId, input.eventKey],
        });
        if (duplicate.rows[0] !== undefined) {
          return Object.freeze({ outcome: "duplicate" as const });
        }
        const spent = await client.query<Record<string, unknown>>({
          text: `
            select count(*)::int as used
            from public.push_deliveries
            where push_token_id = $1
              and mandatory = $2
              and created_at >= clock_timestamp() - make_interval(secs => $3::double precision)
          `,
          values: [input.pushTokenId, input.mandatory, input.windowSeconds],
        });
        const used = z
          .object({ used: z.number().int().nonnegative() })
          .strict()
          .parse(spent.rows[0]).used;
        if (used >= input.limit) {
          return Object.freeze({ outcome: "rateLimited" as const });
        }
        const inserted = await client.query<Record<string, unknown>>({
          text: `
            insert into public.push_deliveries (
              owner_user_id,
              push_token_id,
              event_type,
              event_key,
              mandatory
            )
            values ($1, $2, $3, $4, $5)
            returning delivery_id
          `,
          values: [
            input.ownerUserId,
            input.pushTokenId,
            input.eventType,
            input.eventKey,
            input.mandatory,
          ],
        });
        const deliveryId = z
          .object({ delivery_id: uuidSchema })
          .strict()
          .parse(inserted.rows[0]).delivery_id;
        return Object.freeze({ outcome: "reserved" as const, deliveryId });
      });
    },

    async completeDelivery(rawInput: CompleteDeliveryInput): Promise<void> {
      const input = completeInputSchema.parse(rawInput);
      await pool.query({
        text: `
          update public.push_deliveries
          set status = $2,
              reason_code = $3,
              provider_message_ref = $4,
              completed_at = clock_timestamp()
          where delivery_id = $1 and status = 'pending'
        `,
        values: [
          input.deliveryId,
          input.status,
          input.reasonCode,
          input.providerMessageRef,
        ],
      });
      if (input.status === "sent") {
        await pool.query({
          text: `
            update public.device_push_tokens
            set last_delivery_at = clock_timestamp()
            where push_token_id = (
              select push_token_id from public.push_deliveries
              where delivery_id = $1
            )
          `,
          values: [input.deliveryId],
        });
      }
    },

    async revokeToken(rawInput: {
      readonly pushTokenId: string;
      readonly reason: (typeof pushTokenRevokeReasons)[number];
    }): Promise<void> {
      const input = revokeInputSchema.parse(rawInput);
      await pool.query({
        text: `
          update public.device_push_tokens
          set status = 'revoked',
              revoked_at = clock_timestamp(),
              revoke_reason = $2
          where push_token_id = $1 and status = 'active'
        `,
        values: [input.pushTokenId, input.reason],
      });
    },
  });
}
