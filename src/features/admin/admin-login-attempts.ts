import { isIP } from "node:net";

import {
  adminLoginLockSeconds,
  adminLoginMaximumFailures,
} from "./admin-contract.js";

/**
 * Decision 0110: operator console login throttling, per login name and per
 * client address, shared by every API instance (`admin_login_attempts`,
 * migration 000057). Replaces the per-process global lock of Decision 0105.
 *
 * - Username bucket (lower-cased name): consecutive failures; the
 *   `usernameMaximumFailures`-th locks that name for `usernameLockSeconds`.
 *   A successful login deletes the bucket. Failing on one name never locks
 *   another one.
 * - IP bucket: `ipMaximumFailures` failures inside `ipWindowSeconds` (fixed
 *   window from the first failure) lock the address for `ipLockSeconds`,
 *   whatever names were tried. A success refunds only its own reservation,
 *   so one valid account cannot reset an address's count.
 * - Every attempt reserves one failure in both buckets before the password
 *   is verified (row-locked in PostgreSQL), so concurrent attempts — on one
 *   or several instances — cannot pass a lock. The reservation that reaches
 *   the maximum sets the lock at once; a success or a refunded attempt
 *   lifts it again.
 * - Buckets idle for `adminLoginAttemptRetentionSeconds` are forgotten.
 *
 * The state transitions are pure functions shared by the PostgreSQL store
 * and the in-memory store (used without a database, where only the
 * bootstrap administrator can log in, and in tests).
 */

export type AdminLoginLockScope = "username" | "ip";

export interface AdminLoginPolicy {
  readonly usernameMaximumFailures: number;
  readonly usernameLockSeconds: number;
  readonly ipMaximumFailures: number;
  readonly ipWindowSeconds: number;
  readonly ipLockSeconds: number;
}

export const defaultAdminLoginPolicy: AdminLoginPolicy = Object.freeze({
  usernameMaximumFailures: adminLoginMaximumFailures,
  usernameLockSeconds: adminLoginLockSeconds,
  ipMaximumFailures: 50,
  ipWindowSeconds: 15 * 60,
  ipLockSeconds: 15 * 60,
});

/** A bucket with no failure for a day is deleted. */
export const adminLoginAttemptRetentionSeconds = 24 * 60 * 60;

export interface AdminLoginSubjects {
  readonly usernameKey: string;
  readonly ipKey: string;
}

export type AdminLoginReservation =
  | {
      readonly status: "locked";
      readonly scope: AdminLoginLockScope;
      readonly retryAfterSeconds: number;
    }
  | { readonly status: "reserved" };

export interface AdminLoginBucketOutcome {
  readonly failures: number;
  /** Seconds until the bucket's lock lifts; 0 when not locked. */
  readonly lockedForSeconds: number;
}

export interface AdminLoginFailureOutcome {
  readonly username: AdminLoginBucketOutcome;
  readonly ip: AdminLoginBucketOutcome;
}

export interface AdminLoginAttemptStore {
  /**
   * Refuses when either bucket is locked (nothing counted); otherwise
   * counts one failure in both buckets before the password is verified.
   */
  reserve(
    subjects: AdminLoginSubjects,
    policy: AdminLoginPolicy,
  ): Promise<AdminLoginReservation>;
  /** Wrong credentials: the reservation stays; a reached maximum locks. */
  fail(
    subjects: AdminLoginSubjects,
    policy: AdminLoginPolicy,
  ): Promise<AdminLoginFailureOutcome>;
  /** Right credentials: the username bucket is cleared, the IP refunded. */
  succeed(
    subjects: AdminLoginSubjects,
    policy: AdminLoginPolicy,
  ): Promise<void>;
  /** No verdict (database error, argon2 busy): both reservations refunded. */
  cancel(subjects: AdminLoginSubjects, policy: AdminLoginPolicy): Promise<void>;
}

const accountUsernamePattern = /^[A-Za-z0-9._@-]{1,64}$/u;
/**
 * A typed name that no account can have shares one bucket, so arbitrary
 * text (possibly a password typed into the name field) is never stored.
 */
export const adminLoginMalformedUsernameKey = "~malformed";
export const adminLoginUnknownIpKey = "unknown";

export function adminLoginUsernameKey(username: string): string {
  return accountUsernamePattern.test(username)
    ? username.toLowerCase()
    : adminLoginMalformedUsernameKey;
}

function expandIpv6(address: string): string[] | null {
  const zoneless = address.split("%")[0] ?? "";
  let text = zoneless;
  // An embedded IPv4 tail becomes two hextets.
  const ipv4Tail = /(\d+\.\d+\.\d+\.\d+)$/u.exec(text);
  if (ipv4Tail !== null) {
    const octets = ipv4Tail[1]!.split(".").map(Number);
    text =
      text.slice(0, text.length - ipv4Tail[1]!.length) +
      ((octets[0]! << 8) | octets[1]!).toString(16) +
      ":" +
      ((octets[2]! << 8) | octets[3]!).toString(16);
  }
  const halves = text.split("::");
  if (halves.length > 2) {
    return null;
  }
  const head = halves[0] === "" ? [] : halves[0]!.split(":");
  const tail =
    halves.length === 2 ? (halves[1] === "" ? [] : halves[1]!.split(":")) : [];
  const fill = halves.length === 2 ? 8 - head.length - tail.length : 0;
  if (fill < 0) {
    return null;
  }
  const groups = [...head, ...Array<string>(fill).fill("0"), ...tail];
  return groups.length === 8
    ? groups.map((group) => group.toLowerCase())
    : null;
}

/**
 * The IP bucket of a client address: IPv4 as is (an IPv4-mapped IPv6
 * address too), IPv6 by its /64 prefix (one end site), anything else the
 * shared `unknown` bucket.
 */
export function adminLoginIpKey(address: string | null | undefined): string {
  if (typeof address !== "string") {
    return adminLoginUnknownIpKey;
  }
  const trimmed = address.trim();
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/iu.exec(trimmed);
  const candidate = mapped === null ? trimmed : mapped[1]!;
  const version = isIP(candidate);
  if (version === 4) {
    return candidate;
  }
  if (version === 6) {
    const groups = expandIpv6(candidate);
    if (groups !== null) {
      return `${groups
        .slice(0, 4)
        .map((group) => group.replace(/^0+(?=.)/u, ""))
        .join(":")}::/64`;
    }
  }
  return adminLoginUnknownIpKey;
}

/** One bucket's stored state (milliseconds since the epoch). */
export interface AdminLoginBucketState {
  readonly failures: number;
  readonly windowStartedAtMs: number;
  readonly lockedUntilMs: number | null;
}

interface BucketPolicy {
  readonly maximumFailures: number;
  readonly lockMs: number;
  /** null = consecutive failures, no window. */
  readonly windowMs: number | null;
}

export function adminLoginBucketPolicy(
  scope: AdminLoginLockScope,
  policy: AdminLoginPolicy,
): BucketPolicy {
  return scope === "username"
    ? {
        maximumFailures: policy.usernameMaximumFailures,
        lockMs: policy.usernameLockSeconds * 1000,
        windowMs: null,
      }
    : {
        maximumFailures: policy.ipMaximumFailures,
        lockMs: policy.ipLockSeconds * 1000,
        windowMs: policy.ipWindowSeconds * 1000,
      };
}

const emptyBucket = (nowMs: number): AdminLoginBucketState => ({
  failures: 0,
  windowStartedAtMs: nowMs,
  lockedUntilMs: null,
});

/** An expired lock or window starts the bucket over. */
export function normalizeAdminLoginBucket(
  bucket: AdminLoginBucketState | null,
  policy: BucketPolicy,
  nowMs: number,
): AdminLoginBucketState {
  if (bucket === null) {
    return emptyBucket(nowMs);
  }
  if (bucket.lockedUntilMs !== null) {
    return bucket.lockedUntilMs <= nowMs ? emptyBucket(nowMs) : bucket;
  }
  if (
    policy.windowMs !== null &&
    bucket.failures > 0 &&
    bucket.windowStartedAtMs + policy.windowMs <= nowMs
  ) {
    return emptyBucket(nowMs);
  }
  return bucket;
}

export function adminLoginLockedForSeconds(
  bucket: AdminLoginBucketState,
  nowMs: number,
): number {
  if (bucket.lockedUntilMs === null || bucket.lockedUntilMs <= nowMs) {
    return 0;
  }
  return Math.ceil((bucket.lockedUntilMs - nowMs) / 1000);
}

export function reserveAdminLoginBucket(
  bucket: AdminLoginBucketState,
  policy: BucketPolicy,
  nowMs: number,
): AdminLoginBucketState {
  const failures = bucket.failures + 1;
  return {
    failures,
    windowStartedAtMs: bucket.failures === 0 ? nowMs : bucket.windowStartedAtMs,
    lockedUntilMs:
      failures >= policy.maximumFailures ? nowMs + policy.lockMs : null,
  };
}

export function failAdminLoginBucket(
  bucket: AdminLoginBucketState,
  policy: BucketPolicy,
  nowMs: number,
): AdminLoginBucketState {
  if (bucket.failures < policy.maximumFailures) {
    return bucket;
  }
  return {
    ...bucket,
    lockedUntilMs: Math.max(bucket.lockedUntilMs ?? 0, nowMs + policy.lockMs),
  };
}

export function refundAdminLoginBucket(
  bucket: AdminLoginBucketState,
  policy: BucketPolicy,
): AdminLoginBucketState {
  const failures = Math.max(0, bucket.failures - 1);
  return {
    ...bucket,
    failures,
    lockedUntilMs:
      failures >= policy.maximumFailures ? bucket.lockedUntilMs : null,
  };
}

/**
 * The lock answer for two locked buckets: the longer one; a tie names the
 * username.
 */
export function adminLoginLockAnswer(
  usernameSeconds: number,
  ipSeconds: number,
): AdminLoginReservation {
  if (usernameSeconds === 0 && ipSeconds === 0) {
    return { status: "reserved" };
  }
  return ipSeconds > usernameSeconds
    ? { status: "locked", scope: "ip", retryAfterSeconds: ipSeconds }
    : {
        status: "locked",
        scope: "username",
        retryAfterSeconds: usernameSeconds,
      };
}

const memoryStorePruneThreshold = 10_000;

/**
 * In-process store: the console without a database (bootstrap
 * administrator only) and tests. Same transitions as PostgreSQL.
 */
export function createMemoryAdminLoginAttemptStore(
  options: { readonly now?: () => Date } = {},
): AdminLoginAttemptStore {
  const now = options.now ?? (() => new Date());
  const buckets = new Map<
    string,
    AdminLoginBucketState & { readonly touchedAtMs: number }
  >();
  const keyOf = (scope: AdminLoginLockScope, subject: string) =>
    `${scope}\u0000${subject}`;

  function read(
    scope: AdminLoginLockScope,
    subject: string,
    policy: AdminLoginPolicy,
    nowMs: number,
  ): AdminLoginBucketState {
    const stored = buckets.get(keyOf(scope, subject)) ?? null;
    if (
      stored !== null &&
      stored.touchedAtMs + adminLoginAttemptRetentionSeconds * 1000 <= nowMs &&
      (stored.lockedUntilMs === null || stored.lockedUntilMs <= nowMs)
    ) {
      buckets.delete(keyOf(scope, subject));
      return emptyBucket(nowMs);
    }
    return normalizeAdminLoginBucket(
      stored,
      adminLoginBucketPolicy(scope, policy),
      nowMs,
    );
  }

  function write(
    scope: AdminLoginLockScope,
    subject: string,
    state: AdminLoginBucketState,
    nowMs: number,
  ): void {
    buckets.set(keyOf(scope, subject), { ...state, touchedAtMs: nowMs });
  }

  /** Bounds the map: idle buckets past the retention are dropped. */
  function prune(nowMs: number): void {
    if (buckets.size < memoryStorePruneThreshold) {
      return;
    }
    for (const [key, bucket] of buckets) {
      if (
        bucket.touchedAtMs + adminLoginAttemptRetentionSeconds * 1000 <=
          nowMs &&
        (bucket.lockedUntilMs === null || bucket.lockedUntilMs <= nowMs)
      ) {
        buckets.delete(key);
      }
    }
  }

  const store: AdminLoginAttemptStore = {
    reserve(subjects, policy) {
      const nowMs = now().getTime();
      prune(nowMs);
      const username = read("username", subjects.usernameKey, policy, nowMs);
      const ip = read("ip", subjects.ipKey, policy, nowMs);
      const locked = adminLoginLockAnswer(
        adminLoginLockedForSeconds(username, nowMs),
        adminLoginLockedForSeconds(ip, nowMs),
      );
      if (locked.status === "locked") {
        return Promise.resolve(locked);
      }
      write(
        "username",
        subjects.usernameKey,
        reserveAdminLoginBucket(
          username,
          adminLoginBucketPolicy("username", policy),
          nowMs,
        ),
        nowMs,
      );
      write(
        "ip",
        subjects.ipKey,
        reserveAdminLoginBucket(
          ip,
          adminLoginBucketPolicy("ip", policy),
          nowMs,
        ),
        nowMs,
      );
      return Promise.resolve({ status: "reserved" as const });
    },
    fail(subjects, policy) {
      const nowMs = now().getTime();
      const outcome = {} as {
        username: AdminLoginBucketOutcome;
        ip: AdminLoginBucketOutcome;
      };
      for (const [scope, subject] of [
        ["username", subjects.usernameKey],
        ["ip", subjects.ipKey],
      ] as const) {
        const next = failAdminLoginBucket(
          read(scope, subject, policy, nowMs),
          adminLoginBucketPolicy(scope, policy),
          nowMs,
        );
        write(scope, subject, next, nowMs);
        outcome[scope] = {
          failures: next.failures,
          lockedForSeconds: adminLoginLockedForSeconds(next, nowMs),
        };
      }
      return Promise.resolve(outcome);
    },
    succeed(subjects, policy) {
      const nowMs = now().getTime();
      buckets.delete(keyOf("username", subjects.usernameKey));
      write(
        "ip",
        subjects.ipKey,
        refundAdminLoginBucket(
          read("ip", subjects.ipKey, policy, nowMs),
          adminLoginBucketPolicy("ip", policy),
        ),
        nowMs,
      );
      return Promise.resolve();
    },
    cancel(subjects, policy) {
      const nowMs = now().getTime();
      for (const [scope, subject] of [
        ["username", subjects.usernameKey],
        ["ip", subjects.ipKey],
      ] as const) {
        write(
          scope,
          subject,
          refundAdminLoginBucket(
            read(scope, subject, policy, nowMs),
            adminLoginBucketPolicy(scope, policy),
          ),
          nowMs,
        );
      }
      return Promise.resolve();
    },
  };
  return Object.freeze(store);
}
