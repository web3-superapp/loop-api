import {
  argon2,
  createHmac,
  randomBytes,
  randomUUID,
  timingSafeEqual,
} from "node:crypto";

import { isAdminRole, type AdminRole } from "./admin-roles.js";
import { adminSessionTtlSeconds } from "./admin-contract.js";

/**
 * Operator console authentication (Decision 0102): one administrator, an
 * argon2id password hash, and a stateless HMAC-signed session cookie.
 *
 * - The hash is a standard PHC string, so any argon2id tool can produce it;
 *   `pnpm admin:hash-password` uses Node's built-in `crypto.argon2`.
 * - The cookie carries `{sid, sub, iat, exp}` signed with
 *   ADMIN_SESSION_SECRET (HMAC-SHA256). Logging out revokes the `sid` in
 *   this process until it expires; rotating the secret revokes every
 *   session.
 * - Decision 0110: failed logins lock per username and per client address
 *   (`admin-login-attempts.ts`, shared through `admin_login_attempts`);
 *   this replaced the per-process global lock of Decision 0105.
 * - Decision 0105: only one verification runs at a time per process (the
 *   rest are 429 ADMIN_LOGIN_BUSY), and argon2 itself never runs more than
 *   `adminArgon2MaximumConcurrency` derivations in this process, so memory
 *   stays bounded at that many × 19 MiB whatever the request rate.
 * - The logout revocations of the bootstrap administrator live in this
 *   process's memory: a restart clears them (rotating ADMIN_SESSION_SECRET
 *   revokes every session).
 */

/**
 * Decision 0109: the console refuses to boot when this Node build has no
 * `crypto.argon2` (every password check would otherwise fail at runtime).
 */
export function adminArgon2Available(): boolean {
  return typeof argon2 === "function";
}

/** OWASP-recommended argon2id baseline (19 MiB, t=2, p=1). */
export const adminArgon2Parameters = Object.freeze({
  memoryKiB: 19_456,
  passes: 2,
  parallelism: 1,
  tagLength: 32,
  saltLength: 16,
});

/** Decision 0105: at most this many argon2 derivations run at once. */
export const adminArgon2MaximumConcurrency = 2;

/** Every argon2 slot is taken; the caller refuses instead of queueing. */
export class AdminArgon2BusyError extends Error {
  constructor() {
    super("The administrator password verifier is busy");
    this.name = "AdminArgon2BusyError";
  }
}

let argon2InFlight = 0;

/** Number of argon2 derivations running now (tests read it). */
export function adminArgon2InFlight(): number {
  return argon2InFlight;
}

async function argon2Derive(input: {
  readonly password: string;
  readonly salt: Buffer;
  readonly memoryKiB: number;
  readonly passes: number;
  readonly parallelism: number;
  readonly tagLength: number;
}): Promise<Buffer> {
  // The slot is taken synchronously, so no queue of 19 MiB buffers can form.
  if (argon2InFlight >= adminArgon2MaximumConcurrency) {
    throw new AdminArgon2BusyError();
  }
  argon2InFlight += 1;
  try {
    return await argon2DeriveUnbounded(input);
  } finally {
    argon2InFlight -= 1;
  }
}

function argon2DeriveUnbounded(input: {
  readonly password: string;
  readonly salt: Buffer;
  readonly memoryKiB: number;
  readonly passes: number;
  readonly parallelism: number;
  readonly tagLength: number;
}): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    argon2(
      "argon2id",
      {
        message: Buffer.from(input.password, "utf8"),
        nonce: input.salt,
        memory: input.memoryKiB,
        passes: input.passes,
        parallelism: input.parallelism,
        tagLength: input.tagLength,
      },
      (error, derived) => {
        if (error !== null) {
          reject(error);
          return;
        }
        resolve(derived);
      },
    );
  });
}

function base64NoPad(value: Buffer): string {
  return value.toString("base64").replace(/=+$/u, "");
}

export async function hashAdminPassword(password: string): Promise<string> {
  if (password.length < 12 || password.length > 256) {
    throw new Error("The administrator password must be 12-256 characters");
  }
  const salt = randomBytes(adminArgon2Parameters.saltLength);
  const derived = await argon2Derive({
    password,
    salt,
    memoryKiB: adminArgon2Parameters.memoryKiB,
    passes: adminArgon2Parameters.passes,
    parallelism: adminArgon2Parameters.parallelism,
    tagLength: adminArgon2Parameters.tagLength,
  });
  return `$argon2id$v=19$m=${adminArgon2Parameters.memoryKiB},t=${adminArgon2Parameters.passes},p=${adminArgon2Parameters.parallelism}$${base64NoPad(salt)}$${base64NoPad(derived)}`;
}

const phcPattern =
  /^\$argon2id\$v=19\$m=([0-9]{1,8}),t=([0-9]{1,3}),p=([0-9]{1,3})\$([A-Za-z0-9+/]+)\$([A-Za-z0-9+/]+)$/u;

/** Constant-time verification against an argon2id PHC string. */
export async function verifyAdminPassword(
  password: string,
  phc: string,
): Promise<boolean> {
  const match = phcPattern.exec(phc);
  if (match === null) {
    return false;
  }
  const [, m, t, p, saltText, hashText] = match;
  const memoryKiB = Number(m);
  const passes = Number(t);
  const parallelism = Number(p);
  const salt = Buffer.from(saltText ?? "", "base64");
  const expected = Buffer.from(hashText ?? "", "base64");
  if (
    memoryKiB < 8 * parallelism ||
    memoryKiB > 4_194_304 ||
    passes < 1 ||
    parallelism < 1 ||
    salt.length < 8 ||
    expected.length < 16 ||
    password.length > 1_024
  ) {
    return false;
  }
  const derived = await argon2Derive({
    password,
    salt,
    memoryKiB,
    passes,
    parallelism,
    tagLength: expected.length,
  });
  return timingSafeEqual(derived, expected);
}

export interface AdminSession {
  readonly sessionId: string;
  /** Display username; the `actor` of console audit rows. */
  readonly actor: string;
  /**
   * Decision 0109: the `admin_accounts.id`, or null for the ADMIN_USERNAME
   * bootstrap administrator (environment, never stored).
   */
  readonly accountId: string | null;
  /** Decision 0109: the role at issue time (re-checked per request). */
  readonly role: AdminRole;
  readonly issuedAt: string;
  readonly expiresAt: string;
  /**
   * Decision 0109: `admin_accounts.credentials_version` at issue time (null
   * for the bootstrap administrator); a password change or reset bumps the
   * version and ends every older session.
   */
  readonly credentialsVersion: number | null;
}

/** Who a session is issued to (Decision 0109). */
export interface AdminSessionIdentity {
  readonly actor: string;
  readonly accountId: string | null;
  readonly role: AdminRole;
  readonly credentialsVersion: number | null;
}

export interface AdminSessionCodec {
  /** A bare username means the ADMIN_USERNAME bootstrap administrator. */
  issue(identity: string | AdminSessionIdentity): {
    readonly token: string;
    readonly session: AdminSession;
  };
  /**
   * Null for a malformed, forged, expired, revoked, or foreign token. An
   * account session still has to be checked against `admin_accounts`
   * (disabled, password changed) by the caller.
   */
  verify(token: string | undefined): AdminSession | null;
  revoke(session: AdminSession): void;
}

function base64Url(value: Buffer | string): string {
  return Buffer.from(value).toString("base64url");
}

const sessionUsernamePattern = /^[A-Za-z0-9._@-]{1,64}$/u;
const sessionAccountIdPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;

export function createAdminSessionCodec(input: {
  readonly secret: string;
  /** The ADMIN_USERNAME bootstrap administrator. */
  readonly username: string;
  readonly now?: () => Date;
  readonly ttlSeconds?: number;
}): AdminSessionCodec {
  const now = input.now ?? (() => new Date());
  const ttlSeconds = input.ttlSeconds ?? adminSessionTtlSeconds;
  const key = createHmac("sha256", "loop-admin-session-v1")
    .update(input.secret)
    .digest();
  const revoked = new Map<string, number>();

  function sign(payload: string): string {
    return createHmac("sha256", key).update(payload).digest("base64url");
  }

  function sweep(atSeconds: number): void {
    for (const [sessionId, expiresAt] of revoked) {
      if (expiresAt <= atSeconds) {
        revoked.delete(sessionId);
      }
    }
  }

  return Object.freeze({
    issue(identityInput: string | AdminSessionIdentity) {
      const identity: AdminSessionIdentity =
        typeof identityInput === "string"
          ? {
              actor: identityInput,
              accountId: null,
              role: "platform_admin",
              credentialsVersion: null,
            }
          : identityInput;
      const issuedAtSeconds = Math.floor(now().getTime() / 1000);
      const body = {
        v: 2,
        sid: randomUUID(),
        sub: identity.actor,
        aid: identity.accountId,
        rol: identity.role,
        cv: identity.credentialsVersion,
        iat: issuedAtSeconds,
        exp: issuedAtSeconds + ttlSeconds,
      };
      const payload = base64Url(JSON.stringify(body));
      return Object.freeze({
        token: `${payload}.${sign(payload)}`,
        session: Object.freeze({
          sessionId: body.sid,
          actor: identity.actor,
          accountId: identity.accountId,
          role: identity.role,
          issuedAt: new Date(body.iat * 1000).toISOString(),
          expiresAt: new Date(body.exp * 1000).toISOString(),
          credentialsVersion: identity.credentialsVersion,
        }),
      });
    },
    verify(token: string | undefined) {
      if (token === undefined || token.length > 1_024) {
        return null;
      }
      const parts = token.split(".");
      if (parts.length !== 2) {
        return null;
      }
      const [payload, signature] = parts as [string, string];
      const expected = Buffer.from(sign(payload));
      const given = Buffer.from(signature);
      if (
        expected.length !== given.length ||
        !timingSafeEqual(expected, given)
      ) {
        return null;
      }
      let body: unknown;
      try {
        body = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
      } catch {
        return null;
      }
      if (typeof body !== "object" || body === null) {
        return null;
      }
      const record = body as Record<string, unknown>;
      const atSeconds = Math.floor(now().getTime() / 1000);
      const subject = record["sub"];
      const accountId = record["aid"];
      const role = record["rol"];
      const credentialsVersion = record["cv"];
      if (
        record["v"] !== 2 ||
        typeof record["sid"] !== "string" ||
        typeof subject !== "string" ||
        !sessionUsernamePattern.test(subject) ||
        !isAdminRole(role) ||
        typeof record["iat"] !== "number" ||
        typeof record["exp"] !== "number" ||
        record["exp"] <= atSeconds ||
        record["exp"] - record["iat"] > ttlSeconds ||
        record["iat"] > atSeconds + 60
      ) {
        return null;
      }
      if (accountId === null) {
        // The bootstrap administrator: the configured name, always admin.
        if (
          subject !== input.username ||
          role !== "platform_admin" ||
          credentialsVersion !== null
        ) {
          return null;
        }
      } else if (
        typeof accountId !== "string" ||
        !sessionAccountIdPattern.test(accountId) ||
        typeof credentialsVersion !== "number" ||
        !Number.isSafeInteger(credentialsVersion) ||
        credentialsVersion < 1
      ) {
        return null;
      }
      sweep(atSeconds);
      if (revoked.has(record["sid"])) {
        return null;
      }
      return Object.freeze({
        sessionId: record["sid"],
        actor: subject,
        accountId,
        role,
        issuedAt: new Date(record["iat"] * 1000).toISOString(),
        expiresAt: new Date(record["exp"] * 1000).toISOString(),
        credentialsVersion,
      });
    },
    revoke(session: AdminSession) {
      revoked.set(
        session.sessionId,
        Math.floor(Date.parse(session.expiresAt) / 1000),
      );
    },
  });
}

/** Parses one cookie out of a Cookie header without a plugin. */
export function readCookie(
  header: string | undefined,
  name: string,
): string | undefined {
  if (header === undefined) {
    return undefined;
  }
  for (const part of header.split(";")) {
    const index = part.indexOf("=");
    if (index === -1) {
      continue;
    }
    if (part.slice(0, index).trim() === name) {
      return part.slice(index + 1).trim();
    }
  }
  return undefined;
}

export function sessionCookieHeader(input: {
  readonly name: string;
  readonly value: string;
  readonly maxAgeSeconds: number;
  readonly secure: boolean;
}): string {
  return [
    `${input.name}=${input.value}`,
    "Path=/admin",
    `Max-Age=${input.maxAgeSeconds}`,
    "HttpOnly",
    "SameSite=Strict",
    ...(input.secure ? ["Secure"] : []),
  ].join("; ");
}
