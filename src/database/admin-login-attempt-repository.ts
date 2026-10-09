import type { Pool, PoolClient } from "pg";
import { z } from "zod";

import {
  adminLoginAttemptRetentionSeconds,
  adminLoginBucketPolicy,
  adminLoginLockAnswer,
  adminLoginLockedForSeconds,
  failAdminLoginBucket,
  normalizeAdminLoginBucket,
  refundAdminLoginBucket,
  reserveAdminLoginBucket,
  type AdminLoginAttemptStore,
  type AdminLoginBucketState,
  type AdminLoginLockScope,
  type AdminLoginPolicy,
  type AdminLoginReservation,
  type AdminLoginSubjects,
} from "../features/admin/admin-login-attempts.js";
import { AdminRepositoryUnavailableError } from "../features/admin/admin-repository.js";
import { withV2Transaction } from "./v2-command-support.js";

/**
 * Decision 0110: `admin_login_attempts` (migration 000057). Each call is
 * one transaction that row-locks both buckets of the attempt (username and
 * IP, in a fixed order) and applies the transition shared with the
 * in-memory store, using the database clock so every instance agrees.
 */

const bucketRowSchema = z
  .object({
    scope: z.enum(["username", "ip"]),
    subject_key: z.string(),
    failure_count: z.number().int().nonnegative(),
    window_started_ms: z.string().regex(/^[0-9]{1,16}$/u),
    locked_until_ms: z
      .string()
      .regex(/^[0-9]{1,16}$/u)
      .nullable(),
  })
  .strict();

type Buckets = Record<AdminLoginLockScope, AdminLoginBucketState>;

const unavailable = () => new AdminRepositoryUnavailableError();

export function createPostgresAdminLoginAttemptStore(
  pool: Pool,
): AdminLoginAttemptStore {
  async function locked<T>(
    subjects: AdminLoginSubjects,
    policy: AdminLoginPolicy,
    options: { readonly cleanup: boolean },
    operation: (
      buckets: Buckets,
      nowMs: number,
    ) => { readonly next: Partial<Buckets>; readonly result: T },
  ): Promise<T> {
    try {
      return await withV2Transaction(pool, unavailable, async (client) => {
        const clock = await client.query<{ now_ms: string }>(
          "select floor(extract(epoch from clock_timestamp()) * 1000)::bigint::text as now_ms",
        );
        const nowMs = Number(clock.rows[0]?.now_ms);
        if (!Number.isSafeInteger(nowMs)) {
          throw unavailable();
        }
        if (options.cleanup) {
          await client.query({
            text: `
              delete from public.admin_login_attempts
              where updated_at < clock_timestamp() - make_interval(secs => $1)
                and (locked_until is null or locked_until < clock_timestamp())
            `,
            values: [adminLoginAttemptRetentionSeconds],
          });
        }
        await client.query({
          text: `
            insert into public.admin_login_attempts (scope, subject_key)
            values ('ip', $1), ('username', $2)
            on conflict (scope, subject_key) do nothing
          `,
          values: [subjects.ipKey, subjects.usernameKey],
        });
        const rows = await client.query({
          text: `
            select
              scope,
              subject_key,
              failure_count,
              floor(extract(epoch from window_started_at) * 1000)::bigint::text
                as window_started_ms,
              floor(extract(epoch from locked_until) * 1000)::bigint::text
                as locked_until_ms
            from public.admin_login_attempts
            where (scope = 'ip' and subject_key = $1)
               or (scope = 'username' and subject_key = $2)
            order by scope, subject_key
            for update
          `,
          values: [subjects.ipKey, subjects.usernameKey],
        });
        const buckets: Partial<Buckets> = {};
        for (const raw of rows.rows) {
          const row = bucketRowSchema.parse(raw);
          buckets[row.scope] = normalizeAdminLoginBucket(
            {
              failures: row.failure_count,
              windowStartedAtMs: Number(row.window_started_ms),
              lockedUntilMs:
                row.locked_until_ms === null
                  ? null
                  : Number(row.locked_until_ms),
            },
            adminLoginBucketPolicy(row.scope, policy),
            nowMs,
          );
        }
        if (buckets.username === undefined || buckets.ip === undefined) {
          throw unavailable();
        }
        const { next, result } = operation(buckets as Buckets, nowMs);
        for (const scope of ["ip", "username"] as const) {
          const state = next[scope] ?? (buckets as Buckets)[scope];
          await write(
            client,
            scope,
            scope === "ip" ? subjects.ipKey : subjects.usernameKey,
            state,
          );
        }
        return result;
      });
    } catch (error) {
      if (error instanceof AdminRepositoryUnavailableError) {
        throw error;
      }
      throw new AdminRepositoryUnavailableError({ cause: error });
    }
  }

  async function write(
    client: PoolClient,
    scope: AdminLoginLockScope,
    subject: string,
    state: AdminLoginBucketState,
  ): Promise<void> {
    await client.query({
      text: `
        update public.admin_login_attempts
        set
          failure_count = $3,
          window_started_at = to_timestamp($4::double precision / 1000),
          locked_until = case when $5::text is null then null
            else to_timestamp($5::double precision / 1000) end,
          updated_at = clock_timestamp()
        where scope = $1 and subject_key = $2
      `,
      values: [
        scope,
        subject,
        state.failures,
        String(state.windowStartedAtMs),
        state.lockedUntilMs === null ? null : String(state.lockedUntilMs),
      ],
    });
  }

  return Object.freeze({
    reserve(subjects: AdminLoginSubjects, policy: AdminLoginPolicy) {
      return locked<AdminLoginReservation>(
        subjects,
        policy,
        { cleanup: true },
        (buckets, nowMs) => {
          const answer = adminLoginLockAnswer(
            adminLoginLockedForSeconds(buckets.username, nowMs),
            adminLoginLockedForSeconds(buckets.ip, nowMs),
          );
          if (answer.status === "locked") {
            // Expired locks / windows found on the way are still written back.
            return { next: {}, result: answer };
          }
          return {
            next: {
              username: reserveAdminLoginBucket(
                buckets.username,
                adminLoginBucketPolicy("username", policy),
                nowMs,
              ),
              ip: reserveAdminLoginBucket(
                buckets.ip,
                adminLoginBucketPolicy("ip", policy),
                nowMs,
              ),
            },
            result: answer,
          };
        },
      );
    },
    fail(subjects: AdminLoginSubjects, policy: AdminLoginPolicy) {
      return locked(subjects, policy, { cleanup: false }, (buckets, nowMs) => {
        const username = failAdminLoginBucket(
          buckets.username,
          adminLoginBucketPolicy("username", policy),
          nowMs,
        );
        const ip = failAdminLoginBucket(
          buckets.ip,
          adminLoginBucketPolicy("ip", policy),
          nowMs,
        );
        return {
          next: { username, ip },
          result: {
            username: {
              failures: username.failures,
              lockedForSeconds: adminLoginLockedForSeconds(username, nowMs),
            },
            ip: {
              failures: ip.failures,
              lockedForSeconds: adminLoginLockedForSeconds(ip, nowMs),
            },
          },
        };
      });
    },
    async succeed(subjects: AdminLoginSubjects, policy: AdminLoginPolicy) {
      await locked(subjects, policy, { cleanup: false }, (buckets, nowMs) => ({
        next: {
          username: {
            failures: 0,
            windowStartedAtMs: nowMs,
            lockedUntilMs: null,
          },
          ip: refundAdminLoginBucket(
            buckets.ip,
            adminLoginBucketPolicy("ip", policy),
          ),
        },
        result: undefined,
      }));
      // The cleared username bucket carries nothing; drop the row.
      try {
        await pool.query({
          text: `
            delete from public.admin_login_attempts
            where scope = 'username' and subject_key = $1
              and failure_count = 0 and locked_until is null
          `,
          values: [subjects.usernameKey],
        });
      } catch (error) {
        throw new AdminRepositoryUnavailableError({ cause: error });
      }
    },
    async cancel(subjects: AdminLoginSubjects, policy: AdminLoginPolicy) {
      await locked(subjects, policy, { cleanup: false }, (buckets) => ({
        next: {
          username: refundAdminLoginBucket(
            buckets.username,
            adminLoginBucketPolicy("username", policy),
          ),
          ip: refundAdminLoginBucket(
            buckets.ip,
            adminLoginBucketPolicy("ip", policy),
          ),
        },
        result: undefined,
      }));
    },
  });
}
