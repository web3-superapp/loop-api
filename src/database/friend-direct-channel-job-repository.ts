import type { Pool, QueryResult } from "pg";
import { z } from "zod";

import type {
  FriendDirectChannelJobRecord,
  FriendDirectChannelJobRepository,
  FriendDirectChannelJobSource,
  FriendDirectChannelParticipant,
} from "../features/communication/friend-direct-channel-service.js";

/**
 * Decision 0172: persistence of the `friend_direct_channel` outbox. The
 * enqueue helper runs inside the accept transaction (friend request or
 * message request); the lane methods lease, record and settle rows.
 */

const uuidPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const uuidSchema = z.string().regex(uuidPattern);
const codeSchema = z.string().regex(/^[a-z][a-z0-9_]{0,63}$/);

const jobRowSchema = z
  .object({
    user_id_low: uuidSchema,
    user_id_high: uuidSchema,
    owner_user_id: uuidSchema,
    source: z.enum(["accept", "backfill"]),
    attempts: z.number().int().min(0).max(1000),
    operation_id: uuidSchema.nullable(),
    operation_owner_user_id: uuidSchema.nullable(),
  })
  .strict();

const participantRowSchema = z
  .object({
    id: uuidSchema,
    privy_user_id: z.string().min(1).max(512),
    public_profile_id: uuidSchema.nullable(),
  })
  .strict();

interface TransactionClient {
  query<Row extends Record<string, unknown> = Record<string, unknown>>(config: {
    readonly text: string;
    readonly values?: readonly unknown[];
  }): Promise<QueryResult<Row>>;
}

/**
 * Inserts (or re-arms) the pair's job inside the caller's transaction. A
 * settled row is re-armed so a re-friend after an unfriend gets its channel
 * guarantee again; a pending row is left as it is (its lease and operation
 * stay intact). Idempotent with the app's own get-or-create call: the lane
 * runs the same converging chat operation.
 */
export async function enqueueFriendDirectChannelJob(
  client: TransactionClient,
  input: {
    readonly ownerUserId: string;
    readonly peerUserId: string;
    readonly source: FriendDirectChannelJobSource;
  },
): Promise<void> {
  const ownerUserId = uuidSchema.parse(input.ownerUserId);
  const peerUserId = uuidSchema.parse(input.peerUserId);
  if (ownerUserId === peerUserId) {
    throw new Error("A friend direct channel job needs two accounts");
  }
  await client.query({
    text: `
      insert into public.friend_direct_channel_jobs (
        user_id_low,
        user_id_high,
        owner_user_id,
        source
      ) values (
        least($1::uuid, $2::uuid),
        greatest($1::uuid, $2::uuid),
        $1::uuid,
        $3
      )
      on conflict (user_id_low, user_id_high) do update
      set
        owner_user_id = excluded.owner_user_id,
        source = excluded.source,
        state = 'pending',
        attempts = 0,
        next_attempt_at = clock_timestamp(),
        operation_id = null,
        operation_owner_user_id = null,
        last_error_code = null,
        lease_worker_id = null,
        lease_expires_at = null,
        updated_at = greatest(
          clock_timestamp(),
          friend_direct_channel_jobs.enqueued_at
        )
      where friend_direct_channel_jobs.state <> 'pending'
    `,
    values: [ownerUserId, peerUserId, input.source],
  });
}

function toJob(value: unknown): FriendDirectChannelJobRecord {
  const row = jobRowSchema.parse(value);
  return Object.freeze({
    userIdLow: row.user_id_low,
    userIdHigh: row.user_id_high,
    ownerUserId: row.owner_user_id,
    source: row.source,
    attempts: row.attempts,
    operationId: row.operation_id,
    operationOwnerUserId: row.operation_owner_user_id,
  });
}

export function createPostgresFriendDirectChannelJobRepository(
  pool: Pool,
): FriendDirectChannelJobRepository {
  const keyValues = (input: {
    readonly userIdLow: string;
    readonly userIdHigh: string;
    readonly workerId: string;
  }): readonly string[] => [
    uuidSchema.parse(input.userIdLow),
    uuidSchema.parse(input.userIdHigh),
    uuidSchema.parse(input.workerId),
  ];

  const repository: FriendDirectChannelJobRepository = {
    async enqueueBackfill(input: { readonly limit: number }): Promise<number> {
      const limit = z.number().int().min(1).max(1000).parse(input.limit);
      // The accepter is unknown for an old friendship; the request's
      // recipient is used when it is known, otherwise the low account.
      const result = await pool.query({
        text: `
          insert into public.friend_direct_channel_jobs (
            user_id_low,
            user_id_high,
            owner_user_id,
            source
          )
          select
            friendship.user_id_low,
            friendship.user_id_high,
            coalesce(
              case
                when request.recipient_user_id in (
                  friendship.user_id_low, friendship.user_id_high
                )
                then request.recipient_user_id
              end,
              friendship.user_id_low
            ),
            'backfill'
          from public.friendships as friendship
          left join public.friend_requests as request
            on request.friend_request_id = friendship.accepted_friend_request_id
          where not exists (
              select 1
              from public.direct_channels as direct_record
              where direct_record.user_id_low = friendship.user_id_low
                and direct_record.user_id_high = friendship.user_id_high
                and direct_record.channel_state in (
                  'pending', 'active', 'operator_required'
                )
            )
            and not exists (
              select 1
              from public.friend_direct_channel_jobs as job
              where job.user_id_low = friendship.user_id_low
                and job.user_id_high = friendship.user_id_high
            )
          order by friendship.accepted_at asc, friendship.user_id_low asc
          limit $1
          on conflict (user_id_low, user_id_high) do nothing
        `,
        values: [limit],
      });
      return result.rowCount ?? 0;
    },

    async claimDueJobs(input) {
      const workerId = uuidSchema.parse(input.workerId);
      const leaseSeconds = z
        .number()
        .int()
        .min(1)
        .max(600)
        .parse(input.leaseSeconds);
      const limit = z.number().int().min(1).max(100).parse(input.limit);
      const result = await pool.query<Record<string, unknown>>({
        text: `
          with due as (
            select job.user_id_low, job.user_id_high
            from public.friend_direct_channel_jobs as job
            where job.state = 'pending'
              and job.next_attempt_at <= clock_timestamp()
              and (
                job.lease_expires_at is null
                or job.lease_expires_at <= clock_timestamp()
              )
            order by job.next_attempt_at asc, job.user_id_low asc, job.user_id_high asc
            limit $3
            for update skip locked
          )
          update public.friend_direct_channel_jobs as job
          set
            lease_worker_id = $1,
            lease_expires_at = clock_timestamp() + make_interval(secs => $2::double precision),
            attempts = least(job.attempts + 1, 1000),
            updated_at = greatest(clock_timestamp(), job.enqueued_at)
          from due
          where job.user_id_low = due.user_id_low
            and job.user_id_high = due.user_id_high
          returning
            job.user_id_low,
            job.user_id_high,
            job.owner_user_id,
            job.source,
            job.attempts,
            job.operation_id,
            job.operation_owner_user_id
        `,
        values: [workerId, leaseSeconds, limit],
      });
      return Object.freeze(result.rows.map(toJob));
    },

    async readParticipants(
      userIds: readonly string[],
    ): Promise<readonly FriendDirectChannelParticipant[]> {
      const ids = z.array(uuidSchema).min(1).max(2).parse(userIds);
      const result = await pool.query<Record<string, unknown>>({
        text: `
          select
            account.id,
            account.privy_user_id,
            profile.public_profile_id
          from public.loop_users as account
          left join public.user_profiles as profile
            on profile.owner_user_id = account.id
          where account.id = any($1::uuid[])
          order by account.id
        `,
        values: [ids],
      });
      return Object.freeze(
        result.rows.map((value) => {
          const row = participantRowSchema.parse(value);
          return Object.freeze({
            userId: row.id,
            privyUserId: row.privy_user_id,
            publicProfileId: row.public_profile_id,
          });
        }),
      );
    },

    async hasActiveDirectChannel(input): Promise<boolean> {
      const result = await pool.query<{ active: boolean }>({
        text: `
          select exists (
            select 1
            from public.direct_channels
            where user_id_low = $1
              and user_id_high = $2
              and channel_state = 'active'
          ) as active
        `,
        values: [
          uuidSchema.parse(input.userIdLow),
          uuidSchema.parse(input.userIdHigh),
        ],
      });
      return result.rows[0]?.active === true;
    },

    async recordOperation(input): Promise<void> {
      const operationId =
        input.operationId === null ? null : uuidSchema.parse(input.operationId);
      const operationOwnerUserId =
        input.operationOwnerUserId === null
          ? null
          : uuidSchema.parse(input.operationOwnerUserId);
      if ((operationId === null) !== (operationOwnerUserId === null)) {
        throw new Error("The operation and its owner are recorded together");
      }
      await pool.query({
        text: `
          update public.friend_direct_channel_jobs
          set
            operation_id = $4,
            operation_owner_user_id = $5,
            updated_at = greatest(clock_timestamp(), enqueued_at)
          where user_id_low = $1
            and user_id_high = $2
            and lease_worker_id = $3
            and state = 'pending'
        `,
        values: [...keyValues(input), operationId, operationOwnerUserId],
      });
    },

    async completeJob(input): Promise<void> {
      const state = z
        .enum(["succeeded", "skipped", "failed"])
        .parse(input.state);
      const errorCode =
        input.errorCode === null ? null : codeSchema.parse(input.errorCode);
      await pool.query({
        text: `
          update public.friend_direct_channel_jobs
          set
            state = $4,
            last_error_code = $5,
            lease_worker_id = null,
            lease_expires_at = null,
            updated_at = greatest(clock_timestamp(), enqueued_at)
          where user_id_low = $1
            and user_id_high = $2
            and lease_worker_id = $3
            and state = 'pending'
        `,
        values: [...keyValues(input), state, errorCode],
      });
    },

    async retryJob(input): Promise<void> {
      const errorCode =
        input.errorCode === null ? null : codeSchema.parse(input.errorCode);
      const delay = z
        .number()
        .int()
        .min(1)
        .max(3600)
        .parse(input.retryDelaySeconds);
      await pool.query({
        text: `
          update public.friend_direct_channel_jobs
          set
            last_error_code = $4,
            next_attempt_at = clock_timestamp() + make_interval(secs => $5::double precision),
            lease_worker_id = null,
            lease_expires_at = null,
            updated_at = greatest(clock_timestamp(), enqueued_at)
          where user_id_low = $1
            and user_id_high = $2
            and lease_worker_id = $3
            and state = 'pending'
        `,
        values: [...keyValues(input), errorCode, delay],
      });
    },
  };
  return Object.freeze(repository);
}
