import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";

import type { CommunityReviewService } from "../community/community-review-service.js";
import {
  defineIntelPromotions,
  intelPromotionDeeplinkPatternSource,
  intelPromotionImageUrlMaximumLength,
  intelPromotions as shippedIntelPromotions,
  isAllowedIntelPromotionImageUrl,
  intelPromotionsMaximumItems,
  InvalidIntelPromotionError,
  type IntelPromotion,
} from "../market/intel-promotions.js";
import {
  isCommunityWeightWithinRange,
  isUnsignedDecimalString,
  miningDailyOutputUnitKey,
  miningFormulaDocumentSchema,
  miningWeightRangeDocumentSchema,
  type MiningFormulaDocument,
  type MiningWeightRangeDocument,
} from "../mining/mining-contract.js";
import type {
  MemePauseAction,
  MemePauseSender,
} from "../../integrations/meme/meme-pause-sender.js";
import {
  AdminApiError,
  adminReasonCodes,
  type AdminErrorDetailsSafe,
} from "./admin-contract.js";
import {
  AdminArgon2BusyError,
  createAdminSessionCodec,
  verifyAdminPassword,
  type AdminSession,
  type AdminSessionCodec,
} from "./admin-auth.js";
import {
  adminLoginIpKey,
  adminLoginUsernameKey,
  createMemoryAdminLoginAttemptStore,
  defaultAdminLoginPolicy,
  type AdminLoginAttemptStore,
  type AdminLoginFailureOutcome,
  type AdminLoginLockScope,
  type AdminLoginPolicy,
  type AdminLoginSubjects,
} from "./admin-login-attempts.js";
import {
  adminPrincipalFromAccount,
  type AdminAccountCredentialRecord,
  type AdminAccountRecord,
  type AdminAccountRepository,
  type AdminPrincipal,
} from "./admin-accounts.js";
import { adminRoleHasPermission } from "./admin-roles.js";
import {
  AdminRepositoryUnavailableError,
  AdminSeparationOfDutiesError,
  AdminStateConflictError,
  AdminTargetNotFoundError,
  AdminValidationError,
  type AdminAuditInput,
  type AdminAuditRecord,
  type AdminCommunityRecord,
  type AdminCommunityWeightEntry,
  type AdminFormulaVersionRecord,
  type AdminMemeTokenRecord,
  type AdminRepository,
} from "./admin-repository.js";
import {
  databaseIntelPromotionsConfigVersion,
  parseIntelPromotionsValue,
  parseRecommendedCommunityIdsValue,
  shippedIntelPromotionsVersion,
  type AdminSettingsReader,
} from "./admin-settings-reader.js";

/**
 * Operator console behaviour (Decision 0102). Routes validate shapes; this
 * service enforces the rules and maps every repository outcome onto the
 * console error catalog. Each management write lands with its audit row
 * (in the same transaction where the repository owns the write).
 */

export interface AdminServiceLogger {
  warn(context: Record<string, unknown>, message: string): void;
}

export type AdminMemePauseRuntime =
  | { readonly status: "available"; readonly sender: MemePauseSender }
  | { readonly status: "unavailable"; readonly reasonCode: string };

export interface AdminServiceOptions {
  readonly username: string;
  readonly passwordHash: string;
  readonly sessionSecret: string;
  readonly repository: AdminRepository;
  readonly settingsReader: AdminSettingsReader;
  /** `RECOMMENDED_COMMUNITY_IDS` (Decision 0095), the fallback list. */
  readonly environmentRecommendedCommunityIds: readonly string[];
  /**
   * Decision 0105: `INTEL_PROMOTION_IMAGE_HOSTS`. Empty (the default) =
   * every promotion `imageUrl` must be null.
   */
  readonly promotionImageHosts?: readonly string[];
  /** Null when the community repository is not composed. */
  readonly communityReview: CommunityReviewService | null;
  readonly memePause: AdminMemePauseRuntime;
  /** `NODE_ENV=production` refuses formula approval, like the script. */
  readonly production: boolean;
  readonly logger: AdminServiceLogger;
  readonly now?: () => Date;
  readonly sessionCodec?: AdminSessionCodec;
  /**
   * Decision 0110: login failure buckets per username and per client
   * address. PostgreSQL (`admin_login_attempts`) when a database is
   * composed; null/omitted = in-process store (no database: only the
   * bootstrap administrator can log in).
   */
  readonly loginAttempts?: AdminLoginAttemptStore | null;
  /** Decision 0110: `ADMIN_LOGIN_*` limits (defaults 5 / 900 / 50 / 900 / 900). */
  readonly loginPolicy?: AdminLoginPolicy;
  /**
   * Decision 0109: console accounts. Null (no database) = only the
   * ADMIN_USERNAME bootstrap administrator can log in.
   */
  readonly accounts?: AdminAccountRepository | null;
}

export interface AdminAuditReference {
  readonly auditId: string;
  readonly seq: number;
  readonly at: string;
}

export interface AdminWriteContext {
  readonly session: AdminSession;
  readonly requestId: string;
}

export const adminListLimits = Object.freeze({
  default: 20,
  maximum: 100,
});
export const adminRecentAuditCount = 20;
/**
 * Decision 0105: how long a broadcast pause/unpause blocks a second one of
 * the same token when its state cannot be read (RPC down).
 */
export const memePausePendingMaximumMs = 10 * 60 * 1000;
/** Decision 0105: `Retry-After` of a 429 ADMIN_LOGIN_BUSY. */
export const adminLoginBusyRetryAfterSeconds = 1;

const reasonCodePattern = /^[a-z][a-z0-9_]{0,63}$/u;
const forbiddenTextCharacters = /[\p{Cc}\p{Cf}\p{Cs}\p{Zl}\p{Zp}]/u;
const uuidV4Pattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const canonicalUuidPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const configVersionPattern = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;
const assetIdPattern = /^eip155:[1-9][0-9]{0,9}:(0x[0-9a-f]{40}|native)$/u;

export const intelPromotionDeeplinkChoices = Object.freeze([
  "/intel",
  "/square",
  "/meme",
  "/community/profile?id=<communityId>",
]);

function refuse(
  code: "INVALID_REQUEST" | "VALIDATION_FAILED" | "NOT_FOUND",
  reasonCode: string | null = null,
  details: AdminErrorDetailsSafe = {},
): never {
  throw new AdminApiError(
    code,
    reasonCode === null && Object.keys(details).length === 0
      ? null
      : { ...(reasonCode === null ? {} : { reasonCode }), ...details },
  );
}

function translate(error: unknown): never {
  if (error instanceof AdminApiError) {
    throw error;
  }
  if (error instanceof AdminStateConflictError) {
    throw new AdminApiError("ADMIN_CONFLICT", {
      reasonCode: error.reasonCode,
      ...error.details,
    });
  }
  if (error instanceof AdminTargetNotFoundError) {
    throw new AdminApiError("NOT_FOUND", { reasonCode: error.reasonCode });
  }
  if (error instanceof AdminSeparationOfDutiesError) {
    throw new AdminApiError("PERMISSION_DENIED", {
      reasonCode: error.reasonCode,
    });
  }
  if (error instanceof AdminValidationError) {
    throw new AdminApiError("VALIDATION_FAILED", {
      reasonCode: error.reasonCode,
      ...error.details,
    });
  }
  if (error instanceof AdminRepositoryUnavailableError) {
    throw new AdminApiError("CAPABILITY_UNAVAILABLE", {
      reasonCode: adminReasonCodes.databaseUnavailable,
    });
  }
  throw error;
}

function auditReference(audit: AdminAuditRecord): AdminAuditReference {
  return Object.freeze({
    auditId: audit.auditId,
    seq: audit.seq,
    at: audit.at,
  });
}

function reasonText(value: unknown, required: boolean): string | null {
  if (value === undefined || value === null) {
    if (required) {
      refuse("VALIDATION_FAILED", "ADMIN_REASON_TEXT_REQUIRED");
    }
    return null;
  }
  if (typeof value !== "string") {
    refuse("INVALID_REQUEST");
  }
  const trimmed = value.trim();
  const codePoints = Array.from(trimmed).length;
  if (codePoints === 0) {
    if (required) {
      refuse("VALIDATION_FAILED", "ADMIN_REASON_TEXT_REQUIRED");
    }
    return null;
  }
  if (codePoints > 280 || forbiddenTextCharacters.test(trimmed)) {
    refuse("VALIDATION_FAILED", "ADMIN_REASON_TEXT_INVALID");
  }
  return trimmed;
}

function reasonCode(value: unknown): string {
  if (typeof value !== "string" || !reasonCodePattern.test(value)) {
    refuse("VALIDATION_FAILED", "ADMIN_REASON_CODE_INVALID");
  }
  return value;
}

function expectedUpdatedAt(value: unknown): string | null {
  if (value === null) {
    return null;
  }
  if (typeof value !== "string" || !Number.isFinite(Date.parse(value))) {
    refuse("INVALID_REQUEST");
  }
  return new Date(value).toISOString();
}

function parseLimit(value: unknown): number {
  if (value === undefined) {
    return adminListLimits.default;
  }
  const parsed =
    typeof value === "number"
      ? value
      : typeof value === "string" && /^[1-9][0-9]{0,2}$/u.test(value)
        ? Number(value)
        : Number.NaN;
  if (
    !Number.isInteger(parsed) ||
    parsed < 1 ||
    parsed > adminListLimits.maximum
  ) {
    refuse("INVALID_REQUEST");
  }
  return parsed;
}

/** Decision 0163: the console list of launch2 instances (no cursor). */
export const adminLaunch2ListingListLimit = 200;

function optionalQuery(value: unknown): string | null {
  if (value === undefined) {
    return null;
  }
  if (typeof value !== "string") {
    refuse("INVALID_REQUEST");
  }
  const trimmed = value.trim();
  if (trimmed.length > 64) {
    refuse("INVALID_REQUEST");
  }
  return trimmed === "" ? null : trimmed;
}

/** Projection of a formula version: the editable parameters surfaced. */
export function projectFormulaVersion(record: AdminFormulaVersionRecord) {
  const placeholders = record.formula.placeholders;
  return Object.freeze({
    configVersion: record.configVersion,
    status: record.status,
    scope: record.formula.scope ?? null,
    effectiveAt: record.effectiveAt,
    approvedAt: record.approvedAt,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
    parameters: Object.freeze({
      assetWeights: record.formula.assetWeights,
      dailyOutputBudget: record.formula.dailyOutput?.budget ?? null,
      referralBoostStatus: record.formula.referralBoost.status,
      communityWeightRange: record.weightRange.community.range ?? null,
      communityWeights: record.communityWeights,
      nftWeight: placeholders?.nftWeight ?? null,
      inviteInitialPower: placeholders?.inviteInitialPower ?? null,
    }),
    formula: record.formula,
    weightRange: record.weightRange,
    priceGuardRules: record.priceGuardRules,
    draftAuthor:
      record.draftAuthor === null
        ? null
        : Object.freeze({
            kind: record.draftAuthor.kind,
            username: record.draftAuthor.actor,
            accountId: record.draftAuthor.accountId,
          }),
    approvedBy:
      record.approvedBy === null
        ? null
        : Object.freeze({
            username: record.approvedBy.actor,
            accountId: record.approvedBy.accountId,
          }),
  });
}

function projectCommunity(record: AdminCommunityRecord) {
  return record;
}

function projectMeme(record: AdminMemeTokenRecord) {
  return record;
}

function projectAudit(record: AdminAuditRecord) {
  return record;
}

export interface AdminService {
  readonly sessionCodec: AdminSessionCodec;
  login(input: {
    readonly username: unknown;
    readonly password: unknown;
    readonly requestId: string;
    /**
     * Decision 0110: the client address (Fastify `request.ip`, behind the
     * trusted proxy). Omitted = the shared `unknown` IP bucket.
     */
    readonly sourceIp?: string | null;
  }): Promise<{
    readonly token: string;
    readonly session: AdminSession;
    readonly principal: AdminPrincipal;
  }>;
  /**
   * Decision 0109: the cookie's principal, re-checked against
   * `admin_accounts` for an account session (disabled, password changed,
   * role drift → null). Null = 401.
   */
  resolvePrincipal(token: string | undefined): Promise<AdminPrincipal | null>;
  /** Decision 0109: after a password change, a fresh cookie for the account. */
  reissueSession(
    previous: AdminSession,
    account: AdminAccountRecord,
  ): { readonly token: string; readonly session: AdminSession };
  logout(context: AdminWriteContext): Promise<void>;
  overview(): Promise<Record<string, unknown>>;
  getRecommendedCommunities(): Promise<Record<string, unknown>>;
  putRecommendedCommunities(
    context: AdminWriteContext,
    body: { readonly communityIds: unknown; readonly updatedAt: unknown },
  ): Promise<Record<string, unknown>>;
  getIntelPromotions(): Promise<Record<string, unknown>>;
  putIntelPromotions(
    context: AdminWriteContext,
    body: { readonly items: unknown; readonly updatedAt: unknown },
  ): Promise<Record<string, unknown>>;
  listCommunities(query: {
    readonly status?: unknown;
    readonly q?: unknown;
    readonly cursor?: unknown;
    readonly limit?: unknown;
  }): Promise<Record<string, unknown>>;
  getCommunity(communityId: string): Promise<Record<string, unknown>>;
  reviewCommunity(
    context: AdminWriteContext,
    communityId: string,
    body: {
      readonly decision: unknown;
      readonly reasonCode: unknown;
      readonly reasonText?: unknown;
    },
  ): Promise<Record<string, unknown>>;
  listFormulaVersions(): Promise<Record<string, unknown>>;
  createFormulaDraft(
    context: AdminWriteContext,
    body: {
      readonly configVersion: unknown;
      readonly baseVersion: unknown;
      readonly parameters?: unknown;
    },
  ): Promise<Record<string, unknown>>;
  approveFormula(
    context: AdminWriteContext,
    configVersion: string,
  ): Promise<Record<string, unknown>>;
  withdrawFormula(
    context: AdminWriteContext,
    configVersion: string,
  ): Promise<Record<string, unknown>>;
  listMemeTokens(query: {
    readonly status?: unknown;
    readonly listing?: unknown;
    readonly q?: unknown;
    readonly cursor?: unknown;
    readonly limit?: unknown;
  }): Promise<Record<string, unknown>>;
  setMemeListing(
    context: AdminWriteContext,
    memeTokenId: string,
    body: {
      readonly listing: unknown;
      readonly reasonCode: unknown;
      readonly reasonText?: unknown;
    },
  ): Promise<Record<string, unknown>>;
  /** Decision 0163: launch2 instances with their list visibility. */
  listLaunch2Instances(query: {
    readonly listing?: unknown;
    readonly q?: unknown;
  }): Promise<Record<string, unknown>>;
  setLaunch2Listing(
    context: AdminWriteContext,
    instanceId: string,
    body: { readonly listing: unknown; readonly reason?: unknown },
  ): Promise<Record<string, unknown>>;
  pauseMeme(
    context: AdminWriteContext,
    memeTokenId: string,
    action: MemePauseAction,
    body: { readonly reasonCode: unknown; readonly reasonText?: unknown },
  ): Promise<Record<string, unknown>>;
  listAudit(query: {
    readonly cursor?: unknown;
    readonly limit?: unknown;
    readonly actor?: unknown;
    readonly action?: unknown;
  }): Promise<Record<string, unknown>>;
}

export function createAdminService(options: AdminServiceOptions): AdminService {
  const now = options.now ?? (() => new Date());
  const sessionCodec =
    options.sessionCodec ??
    createAdminSessionCodec({
      secret: options.sessionSecret,
      username: options.username,
      now,
    });
  const loginAttempts =
    options.loginAttempts ?? createMemoryAdminLoginAttemptStore({ now });
  const loginPolicy = options.loginPolicy ?? defaultAdminLoginPolicy;
  /** Decision 0105: one password verification at a time per process. */
  let loginInFlight = false;
  const repository = options.repository;
  const accounts = options.accounts ?? null;
  const promotionImageHosts = Object.freeze([
    ...(options.promotionImageHosts ?? []),
  ]);
  const cursorKey = createHmac("sha256", "loop-admin-cursor-v1")
    .update(options.sessionSecret)
    .digest();

  function encodeCursor(
    route: string,
    filter: string,
    payload: Readonly<Record<string, string | number>>,
  ): string {
    const body = Buffer.from(
      JSON.stringify({ r: route, f: filter, p: payload }),
    ).toString("base64url");
    const mac = createHmac("sha256", cursorKey)
      .update(body)
      .digest("base64url");
    return `${body}.${mac}`;
  }

  function decodeCursor(
    route: string,
    filter: string,
    cursor: unknown,
  ): Readonly<Record<string, unknown>> {
    if (typeof cursor !== "string" || cursor.length > 1_024) {
      refuse("INVALID_REQUEST");
    }
    const [body, mac, extra] = cursor.split(".");
    if (body === undefined || mac === undefined || extra !== undefined) {
      refuse("INVALID_REQUEST");
    }
    const expected = Buffer.from(
      createHmac("sha256", cursorKey).update(body).digest("base64url"),
    );
    const given = Buffer.from(mac);
    if (expected.length !== given.length || !timingSafeEqual(expected, given)) {
      refuse("INVALID_REQUEST");
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(Buffer.from(body, "base64url").toString("utf8"));
    } catch {
      refuse("INVALID_REQUEST");
    }
    const record = parsed as Record<string, unknown> | null;
    if (
      record === null ||
      typeof record !== "object" ||
      record["r"] !== route ||
      record["f"] !== filter ||
      typeof record["p"] !== "object" ||
      record["p"] === null
    ) {
      refuse("INVALID_REQUEST");
    }
    return record["p"] as Record<string, unknown>;
  }

  async function sessionAudit(input: {
    readonly actor: string;
    readonly actorAccountId?: string | null;
    readonly action: string;
    readonly targetId: string | null;
    readonly after: unknown;
    readonly requestId: string;
  }): Promise<void> {
    try {
      await repository.appendAudit({
        actor: input.actor,
        actorAccountId: input.actorAccountId ?? null,
        action: input.action,
        targetType: "session",
        targetId: input.targetId,
        before: null,
        after: input.after,
        requestId: input.requestId,
      });
    } catch (error) {
      // Session events never block the login itself; the miss is logged.
      options.logger.warn(
        {
          action: input.action,
          requestId: input.requestId,
          errorName: error instanceof Error ? error.name : "unknown",
        },
        "Operator console session audit row was not written",
      );
    }
  }

  /**
   * Decision 0105: the intent row of an external side effect. It is written
   * before anything runs; when it cannot be written the action is refused
   * (503 ADMIN_AUDIT_UNAVAILABLE) and nothing is executed.
   */
  async function intentAudit(
    input: AdminAuditInput,
  ): Promise<AdminAuditRecord> {
    try {
      return await repository.appendAudit(input);
    } catch (error) {
      options.logger.warn(
        {
          action: input.action,
          requestId: input.requestId,
          errorName: error instanceof Error ? error.name : "unknown",
        },
        "Operator console intent audit row was not written; action refused",
      );
      throw new AdminApiError("CAPABILITY_UNAVAILABLE", {
        reasonCode: adminReasonCodes.auditUnavailable,
      });
    }
  }

  /**
   * Decision 0105: the outcome row after the side effect. The effect has
   * already happened, so a failed write is logged (with the intent row's
   * ID) and never turns a done action into an error; null is returned.
   */
  async function outcomeAudit(
    input: AdminAuditInput,
  ): Promise<AdminAuditRecord | null> {
    try {
      return await repository.appendAudit(input);
    } catch (error) {
      options.logger.warn(
        {
          action: input.action,
          requestId: input.requestId,
          errorName: error instanceof Error ? error.name : "unknown",
        },
        "Operator console outcome audit row was not written",
      );
      return null;
    }
  }

  function lockError(
    scope: AdminLoginLockScope,
    retryAfterSeconds: number,
  ): AdminApiError {
    return new AdminApiError("ADMIN_LOGIN_LOCKED", {
      scope,
      retryAfterSeconds,
    });
  }

  async function refundLogin(
    subjects: AdminLoginSubjects,
    requestId: string,
  ): Promise<void> {
    try {
      await loginAttempts.cancel(subjects, loginPolicy);
    } catch (error) {
      options.logger.warn(
        {
          requestId,
          errorName: error instanceof Error ? error.name : "unknown",
        },
        "Operator console login reservation was not refunded",
      );
    }
  }

  /**
   * Decision 0110: one login attempt. Both buckets (lower-cased username,
   * client address) are checked and charged one failure before the
   * password is verified; a wrong password keeps the charge (and may start
   * a lock), a right one clears the username bucket and refunds the
   * address, an attempt without a verdict refunds both.
   */
  async function verifyLogin(input: {
    readonly username: string;
    readonly password: string;
    readonly requestId: string;
    readonly sourceIp: string | null;
  }) {
    const subjects: AdminLoginSubjects = {
      usernameKey: adminLoginUsernameKey(input.username),
      ipKey: adminLoginIpKey(input.sourceIp),
    };
    let reservation;
    try {
      reservation = await loginAttempts.reserve(subjects, loginPolicy);
    } catch (error) {
      // Fail closed: without the shared counters no password is verified.
      options.logger.warn(
        {
          requestId: input.requestId,
          errorName: error instanceof Error ? error.name : "unknown",
        },
        "Operator console login attempts unavailable; login refused",
      );
      throw new AdminApiError("CAPABILITY_UNAVAILABLE", {
        reasonCode: adminReasonCodes.databaseUnavailable,
      });
    }
    if (reservation.status === "locked") {
      throw lockError(reservation.scope, reservation.retryAfterSeconds);
    }
    // Decision 0109: a console account first, then the ADMIN_USERNAME
    // bootstrap administrator. Exactly one argon2 verification runs either
    // way, so an unknown name costs the same time as a wrong password.
    let account: AdminAccountCredentialRecord | null = null;
    if (accounts !== null) {
      try {
        account = await accounts.findByUsername(input.username);
      } catch (error) {
        await refundLogin(subjects, input.requestId);
        options.logger.warn(
          {
            requestId: input.requestId,
            errorName: error instanceof Error ? error.name : "unknown",
          },
          "Operator console account lookup failed; login refused",
        );
        throw new AdminApiError("CAPABILITY_UNAVAILABLE", {
          reasonCode: adminReasonCodes.databaseUnavailable,
        });
      }
    }
    const usernameMatches =
      account === null &&
      input.username.length === options.username.length &&
      timingSafeEqual(
        Buffer.from(input.username),
        Buffer.from(options.username),
      );
    let passwordMatches: boolean;
    try {
      // The hash is always verified so a wrong username costs the same time.
      passwordMatches = await verifyAdminPassword(
        input.password,
        account?.passwordHash ?? options.passwordHash,
      );
    } catch (error) {
      await refundLogin(subjects, input.requestId);
      if (error instanceof AdminArgon2BusyError) {
        throw new AdminApiError("ADMIN_LOGIN_BUSY", {
          retryAfterSeconds: adminLoginBusyRetryAfterSeconds,
        });
      }
      throw error;
    }
    const accepted =
      account === null
        ? usernameMatches && passwordMatches
        : passwordMatches && account.disabledAt === null;
    // A name the audit may show: an existing account or the bootstrap
    // administrator. Anything else typed is never written down.
    const knownUsername =
      account !== null
        ? account.username
        : usernameMatches
          ? options.username
          : null;
    if (!accepted) {
      let outcome: AdminLoginFailureOutcome | null = null;
      try {
        outcome = await loginAttempts.fail(subjects, loginPolicy);
      } catch (error) {
        // The reserved failure is already counted; only the lock refresh
        // was missed.
        options.logger.warn(
          {
            requestId: input.requestId,
            errorName: error instanceof Error ? error.name : "unknown",
          },
          "Operator console login failure was not recorded",
        );
      }
      const usernameLock = outcome?.username.lockedForSeconds ?? 0;
      const ipLock = outcome?.ip.lockedForSeconds ?? 0;
      const lockScope: AdminLoginLockScope | null =
        usernameLock === 0 && ipLock === 0
          ? null
          : ipLock > usernameLock
            ? "ip"
            : "username";
      await sessionAudit({
        actor: "anonymous",
        action: "session.login_failed",
        targetId: null,
        after: {
          locked: lockScope !== null,
          lockScope,
          username: knownUsername,
          accountId: account?.accountId ?? null,
          sourceIp: subjects.ipKey,
          usernameFailures: outcome?.username.failures ?? null,
          ipFailures: outcome?.ip.failures ?? null,
        },
        requestId: input.requestId,
      });
      for (const [scope, seconds, failures] of [
        ["username", usernameLock, outcome?.username.failures ?? null],
        ["ip", ipLock, outcome?.ip.failures ?? null],
      ] as const) {
        if (seconds > 0) {
          await sessionAudit({
            actor: "anonymous",
            action: "session.login_locked",
            targetId: null,
            after: {
              scope,
              retryAfterSeconds: seconds,
              failures,
              username: scope === "username" ? knownUsername : null,
              accountId:
                scope === "username" ? (account?.accountId ?? null) : null,
              sourceIp: subjects.ipKey,
            },
            requestId: input.requestId,
          });
        }
      }
      if (lockScope !== null) {
        throw lockError(lockScope, lockScope === "ip" ? ipLock : usernameLock);
      }
      throw new AdminApiError("ADMIN_LOGIN_INVALID");
    }
    try {
      await loginAttempts.succeed(subjects, loginPolicy);
    } catch (error) {
      // The credentials are right; a missed reset only leaves the counted
      // reservation behind.
      options.logger.warn(
        {
          requestId: input.requestId,
          errorName: error instanceof Error ? error.name : "unknown",
        },
        "Operator console login success was not recorded",
      );
    }
    const issued =
      account === null
        ? sessionCodec.issue(options.username)
        : sessionCodec.issue({
            actor: account.username,
            accountId: account.accountId,
            role: account.role,
            credentialsVersion: account.credentialsVersion,
          });
    await sessionAudit({
      actor: issued.session.actor,
      actorAccountId: issued.session.accountId,
      action: "session.login",
      targetId: issued.session.sessionId,
      after: {
        expiresAt: issued.session.expiresAt,
        role: issued.session.role,
      },
      requestId: input.requestId,
    });
    return Object.freeze({
      ...issued,
      principal: adminPrincipalFromAccount(issued.session, account),
    });
  }

  /** Decision 0105: in-process pause/unpause single flight per token. */
  const pauseInFlight = new Set<string>();
  const pausePending = new Map<
    string,
    { readonly transactionHash: string; readonly submittedAtMs: number }
  >();

  /**
   * A broadcast pause/unpause of the token whose transaction is not mined
   * yet refuses another (409 MEME_PAUSE_PENDING); a mined or dropped one,
   * or one older than `memePausePendingMaximumMs`, is forgotten.
   */
  async function assertNoPendingPause(memeTokenId: string): Promise<void> {
    const pending = pausePending.get(memeTokenId);
    if (pending === undefined) {
      return;
    }
    if (now().getTime() - pending.submittedAtMs >= memePausePendingMaximumMs) {
      pausePending.delete(memeTokenId);
      return;
    }
    if (options.memePause.status !== "available") {
      return;
    }
    const state = await options.memePause.sender
      .transactionState(pending.transactionHash)
      .catch(() => "unknown" as const);
    if (state === "settled") {
      pausePending.delete(memeTokenId);
      return;
    }
    throw new AdminApiError("ADMIN_CONFLICT", {
      reasonCode: adminReasonCodes.memePausePending,
      transactionHash: pending.transactionHash,
    });
  }

  async function recommendedResource() {
    const setting = await repository.getSetting("recommended_community_ids");
    const databaseIds =
      setting === null
        ? null
        : parseRecommendedCommunityIdsValue(setting.value);
    const ids = databaseIds ?? options.environmentRecommendedCommunityIds;
    const communities = await repository.getCommunitiesByIds(ids);
    return Object.freeze({
      communityIds: ids,
      source: databaseIds === null ? "environment" : "database",
      updatedAt: setting?.updatedAt ?? null,
      updatedBy: setting?.updatedBy ?? null,
      environmentCommunityIds: options.environmentRecommendedCommunityIds,
      defaultSelectedCount: 5,
      communities: communities.map((community) =>
        Object.freeze({
          communityId: community.communityId,
          name: community.name,
          slug: community.slug,
          logoRef: community.logoRef,
          verificationStatus: community.verificationStatus,
          memberCount: community.memberCount,
        }),
      ),
    });
  }

  async function promotionsResource() {
    const setting = await repository.getSetting("intel_promotions");
    const databaseItems =
      setting === null ? null : parseIntelPromotionsValue(setting.value);
    const inDatabase = databaseItems !== null && setting !== null;
    return Object.freeze({
      items: databaseItems ?? shippedIntelPromotions,
      source: inDatabase ? "database" : "constant",
      updatedAt: setting?.updatedAt ?? null,
      updatedBy: setting?.updatedBy ?? null,
      configVersion: inDatabase
        ? databaseIntelPromotionsConfigVersion(setting.updatedAt)
        : shippedIntelPromotionsVersion.configVersion,
      effectiveAt: inDatabase
        ? setting.updatedAt
        : shippedIntelPromotionsVersion.effectiveAt,
      deeplinkPattern: intelPromotionDeeplinkPatternSource,
      deeplinkChoices: intelPromotionDeeplinkChoices,
      maximumItems: intelPromotionsMaximumItems,
      imageHosts: promotionImageHosts,
      imageUrlMaximumLength: intelPromotionImageUrlMaximumLength,
    });
  }

  function memePauseState() {
    return options.memePause.status === "available"
      ? Object.freeze({
          available: true,
          reasonCode: null,
          executorAddress: options.memePause.sender.address,
        })
      : Object.freeze({
          available: false,
          reasonCode: options.memePause.reasonCode,
          executorAddress: null,
        });
  }

  function formulaApprovalState() {
    return options.production
      ? Object.freeze({
          available: false,
          reasonCode: adminReasonCodes.formulaApproveProduction,
        })
      : Object.freeze({ available: true, reasonCode: null });
  }

  function parseFormulaParameters(
    raw: unknown,
  ): Readonly<Record<string, unknown>> {
    if (raw === undefined) {
      return {};
    }
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
      refuse("INVALID_REQUEST");
    }
    return raw as Record<string, unknown>;
  }

  async function buildDraft(
    base: AdminFormulaVersionRecord,
    parameters: Readonly<Record<string, unknown>>,
  ): Promise<{
    readonly formula: MiningFormulaDocument;
    readonly weightRange: MiningWeightRangeDocument;
    readonly communityWeights: readonly AdminCommunityWeightEntry[];
  }> {
    const invalid = (field: string): never =>
      refuse("VALIDATION_FAILED", adminReasonCodes.formulaInvalid, { field });
    let formula: MiningFormulaDocument = { ...base.formula };
    let weightRange: MiningWeightRangeDocument = {
      ...base.weightRange,
      community: { ...base.weightRange.community },
    };
    const assetWeights = parameters["assetWeights"];
    if (assetWeights !== undefined) {
      if (
        typeof assetWeights !== "object" ||
        assetWeights === null ||
        Array.isArray(assetWeights) ||
        Object.keys(assetWeights).length > 500
      ) {
        invalid("assetWeights");
      }
      const weights: Record<string, string> = {};
      for (const [assetId, weight] of Object.entries(
        assetWeights as Record<string, unknown>,
      )) {
        if (
          !assetIdPattern.test(assetId) ||
          typeof weight !== "string" ||
          !isUnsignedDecimalString(weight)
        ) {
          invalid("assetWeights");
        }
        weights[assetId] = weight as string;
      }
      formula = { ...formula, assetWeights: weights };
    }
    const budget = parameters["dailyOutputBudget"];
    if (budget !== undefined) {
      if (budget === null) {
        formula = Object.fromEntries(
          Object.entries(formula).filter(([key]) => key !== "dailyOutput"),
        ) as unknown as MiningFormulaDocument;
      } else if (
        typeof budget === "string" &&
        isUnsignedDecimalString(budget)
      ) {
        formula = {
          ...formula,
          dailyOutput: {
            status: "development_placeholder",
            budget,
            unitKey: miningDailyOutputUnitKey,
          },
        };
      } else {
        invalid("dailyOutputBudget");
      }
    }
    const referralBoostStatus = parameters["referralBoostStatus"];
    if (referralBoostStatus !== undefined) {
      if (
        referralBoostStatus !== "pending_approval" &&
        referralBoostStatus !== "approved"
      ) {
        invalid("referralBoostStatus");
      }
      formula = {
        ...formula,
        referralBoost: {
          status: referralBoostStatus as "pending_approval" | "approved",
        },
      };
    }
    const range = parameters["communityWeightRange"];
    if (range !== undefined) {
      if (range === null) {
        weightRange = {
          ...weightRange,
          community: {
            status: weightRange.community.status,
            descriptionKey: weightRange.community.descriptionKey,
          },
        };
      } else {
        const candidate = range as Record<string, unknown>;
        if (
          typeof range !== "object" ||
          typeof candidate["min"] !== "string" ||
          typeof candidate["max"] !== "string" ||
          Object.keys(candidate).length !== 2
        ) {
          invalid("communityWeightRange");
        }
        weightRange = {
          ...weightRange,
          community: {
            ...weightRange.community,
            range: {
              min: candidate["min"] as string,
              max: candidate["max"] as string,
            },
          },
        };
      }
    }
    const nftWeight = parameters["nftWeight"];
    const inviteInitialPower = parameters["inviteInitialPower"];
    if (nftWeight !== undefined || inviteInitialPower !== undefined) {
      const current = formula.placeholders;
      const pick = (value: unknown, previous: string | null, field: string) => {
        if (value === undefined) {
          return previous;
        }
        if (value === null) {
          return null;
        }
        if (typeof value !== "string" || !isUnsignedDecimalString(value)) {
          return invalid(field);
        }
        return value;
      };
      formula = {
        ...formula,
        placeholders: {
          status: "placeholder",
          nftWeight: pick(nftWeight, current?.nftWeight ?? null, "nftWeight"),
          inviteInitialPower: pick(
            inviteInitialPower,
            current?.inviteInitialPower ?? null,
            "inviteInitialPower",
          ),
        },
      };
    }
    const parsedFormula = miningFormulaDocumentSchema.safeParse(formula);
    if (!parsedFormula.success) {
      invalid("formula");
    }
    const parsedRange = miningWeightRangeDocumentSchema.safeParse(weightRange);
    if (!parsedRange.success) {
      invalid("communityWeightRange");
    }

    const rawWeights = parameters["communityWeights"];
    let communityWeights: AdminCommunityWeightEntry[];
    if (rawWeights === undefined) {
      communityWeights = [...(await repository.listApprovedCommunityWeights())];
    } else {
      if (!Array.isArray(rawWeights) || rawWeights.length > 500) {
        invalid("communityWeights");
      }
      communityWeights = (rawWeights as unknown[]).map((entry) => {
        const item = entry as Record<string, unknown> | null;
        if (
          typeof entry !== "object" ||
          item === null ||
          typeof item["communityId"] !== "string" ||
          !canonicalUuidPattern.test(item["communityId"]) ||
          typeof item["weight"] !== "string" ||
          !isUnsignedDecimalString(item["weight"]) ||
          Object.keys(item).length !== 2
        ) {
          return invalid("communityWeights");
        }
        return {
          communityId: item["communityId"],
          weight: item["weight"],
        };
      });
    }
    const seen = new Set<string>();
    const communityRange = parsedRange.data?.community.range;
    for (const entry of communityWeights) {
      if (seen.has(entry.communityId)) {
        invalid("communityWeights");
      }
      seen.add(entry.communityId);
      if (
        communityRange === undefined ||
        !isCommunityWeightWithinRange(entry.weight, communityRange)
      ) {
        refuse("VALIDATION_FAILED", adminReasonCodes.formulaWeightOutOfRange, {
          communityId: entry.communityId,
        });
      }
    }
    const communities = await repository.getCommunitiesByIds([...seen]);
    const byId = new Map(communities.map((c) => [c.communityId, c]));
    const assets = new Set<string>();
    for (const entry of communityWeights) {
      const community = byId.get(entry.communityId);
      if (community === undefined) {
        refuse("VALIDATION_FAILED", adminReasonCodes.communityNotFound, {
          communityId: entry.communityId,
        });
      }
      if (community.boundAssetId === null) {
        refuse("VALIDATION_FAILED", adminReasonCodes.formulaWeightUnbound, {
          communityId: entry.communityId,
        });
      }
      if (assets.has(community.boundAssetId)) {
        refuse("VALIDATION_FAILED", adminReasonCodes.formulaWeightConflict, {
          communityId: entry.communityId,
        });
      }
      assets.add(community.boundAssetId);
    }
    return Object.freeze({
      formula: parsedFormula.data as MiningFormulaDocument,
      weightRange: parsedRange.data as MiningWeightRangeDocument,
      communityWeights: Object.freeze(communityWeights),
    });
  }

  const service: AdminService = {
    sessionCodec,

    async login(input) {
      if (
        typeof input.username !== "string" ||
        typeof input.password !== "string" ||
        input.username.length > 64 ||
        input.password.length > 1_024
      ) {
        refuse("INVALID_REQUEST");
      }
      // Decision 0105: only one verification runs at a time in this
      // process; the flag is taken synchronously before anything awaits.
      if (loginInFlight) {
        throw new AdminApiError("ADMIN_LOGIN_BUSY", {
          retryAfterSeconds: adminLoginBusyRetryAfterSeconds,
        });
      }
      loginInFlight = true;
      try {
        return await verifyLogin({
          username: input.username,
          password: input.password,
          requestId: input.requestId,
          sourceIp: input.sourceIp ?? null,
        });
      } finally {
        loginInFlight = false;
      }
    },

    async resolvePrincipal(token) {
      const session = sessionCodec.verify(token);
      if (session === null) {
        return null;
      }
      if (session.accountId === null) {
        return adminPrincipalFromAccount(session, null);
      }
      if (accounts === null) {
        return null;
      }
      let account: AdminAccountCredentialRecord | null;
      try {
        account = await accounts.get(session.accountId);
      } catch {
        throw new AdminApiError("CAPABILITY_UNAVAILABLE", {
          reasonCode: adminReasonCodes.databaseUnavailable,
        });
      }
      // Fail closed: a disabled account, a changed password (credentials
      // version), or any identity drift ends the session at once.
      if (
        account === null ||
        account.disabledAt !== null ||
        account.username !== session.actor ||
        account.role !== session.role ||
        account.credentialsVersion !== session.credentialsVersion
      ) {
        return null;
      }
      return adminPrincipalFromAccount(session, account);
    },

    reissueSession(previous, account) {
      sessionCodec.revoke(previous);
      return sessionCodec.issue({
        actor: account.username,
        accountId: account.accountId,
        role: account.role,
        credentialsVersion: account.credentialsVersion,
      });
    },

    async logout(context) {
      sessionCodec.revoke(context.session);
      await sessionAudit({
        actor: context.session.actor,
        actorAccountId: context.session.accountId,
        action: "session.logout",
        targetId: context.session.sessionId,
        after: null,
        requestId: context.requestId,
      });
    },

    async overview() {
      try {
        const [counts, recent] = await Promise.all([
          repository.overview(),
          repository.listAudit({
            limit: adminRecentAuditCount,
            beforeSeq: null,
            actor: null,
            action: null,
          }),
        ]);
        const at = now();
        return Object.freeze({
          accounts: counts.accounts,
          communities: counts.communities,
          pendingReviews: counts.pendingReviews,
          voiceRooms: counts.voiceRooms,
          memeTokens: counts.memeTokens,
          indexerLanes: counts.indexerLanes.map((lane) =>
            Object.freeze({
              ...lane,
              secondsSinceUpdate: Math.max(
                0,
                Math.floor((at.getTime() - Date.parse(lane.updatedAt)) / 1000),
              ),
            }),
          ),
          recentAudit: recent.map(projectAudit),
          observedAt: at.toISOString(),
        });
      } catch (error) {
        return translate(error);
      }
    },

    async getRecommendedCommunities() {
      try {
        return await recommendedResource();
      } catch (error) {
        return translate(error);
      }
    },

    async putRecommendedCommunities(context, body) {
      const expected = expectedUpdatedAt(body.updatedAt);
      let ids: string[] | null;
      if (body.communityIds === null) {
        ids = null;
      } else if (
        Array.isArray(body.communityIds) &&
        body.communityIds.length <= 50 &&
        body.communityIds.every(
          (id): id is string =>
            typeof id === "string" && uuidV4Pattern.test(id),
        )
      ) {
        ids = [...body.communityIds];
        if (new Set(ids).size !== ids.length) {
          refuse("VALIDATION_FAILED", "ADMIN_COMMUNITY_DUPLICATED");
        }
      } else {
        refuse("INVALID_REQUEST");
      }
      try {
        if (ids !== null) {
          const found = await repository.getCommunitiesByIds(ids);
          const byId = new Map(found.map((c) => [c.communityId, c]));
          for (const id of ids) {
            const community = byId.get(id);
            if (community === undefined) {
              refuse("VALIDATION_FAILED", adminReasonCodes.communityNotFound, {
                communityId: id,
              });
            }
            if (community.verificationStatus !== "verified") {
              refuse(
                "VALIDATION_FAILED",
                adminReasonCodes.communityNotVerified,
                { communityId: id },
              );
            }
          }
        }
        const written = await repository.writeSetting({
          key: "recommended_community_ids",
          value: ids,
          expectedUpdatedAt: expected,
          audit: {
            actor: context.session.actor,
            actorAccountId: context.session.accountId,
            action: "settings.recommended_communities.update",
            targetType: "setting",
            targetId: "recommended_community_ids",
            requestId: context.requestId,
          },
        });
        options.settingsReader.invalidate("recommended_community_ids");
        return Object.freeze({
          ...(await recommendedResource()),
          audit: auditReference(written.audit),
        });
      } catch (error) {
        return translate(error);
      }
    },

    async getIntelPromotions() {
      try {
        return await promotionsResource();
      } catch (error) {
        return translate(error);
      }
    },

    async putIntelPromotions(context, body) {
      const expected = expectedUpdatedAt(body.updatedAt);
      let items: readonly IntelPromotion[] | null;
      if (body.items === null) {
        items = null;
      } else {
        if (
          !Array.isArray(body.items) ||
          body.items.length > intelPromotionsMaximumItems
        ) {
          refuse("VALIDATION_FAILED", adminReasonCodes.promotionInvalid);
        }
        const candidates = (body.items as unknown[]).map(
          (raw, index): IntelPromotion => {
            const item = raw as Record<string, unknown> | null;
            const startsAt =
              typeof item?.["startsAt"] === "string"
                ? Date.parse(item["startsAt"])
                : Number.NaN;
            const endsAt =
              typeof item?.["endsAt"] === "string"
                ? Date.parse(item["endsAt"])
                : Number.NaN;
            if (
              typeof raw !== "object" ||
              item === null ||
              (item["id"] !== undefined && typeof item["id"] !== "string") ||
              typeof item["title"] !== "string" ||
              typeof item["subtitle"] !== "string" ||
              (item["imageUrl"] !== null &&
                typeof item["imageUrl"] !== "string") ||
              typeof item["deeplink"] !== "string" ||
              typeof item["order"] !== "number" ||
              !Number.isFinite(startsAt) ||
              !Number.isFinite(endsAt)
            ) {
              return refuse(
                "VALIDATION_FAILED",
                adminReasonCodes.promotionInvalid,
                { index },
              );
            }
            return {
              id: item["id"] ?? randomUUID(),
              title: item["title"].trim(),
              subtitle: item["subtitle"].trim(),
              imageUrl: item["imageUrl"],
              deeplink: item["deeplink"],
              startsAt: new Date(startsAt).toISOString(),
              endsAt: new Date(endsAt).toISOString(),
              order: item["order"],
            };
          },
        );
        // Item-level check first so the refusal can name the row.
        candidates.forEach((candidate, index) => {
          if (
            candidate.imageUrl !== null &&
            !isAllowedIntelPromotionImageUrl(
              candidate.imageUrl,
              promotionImageHosts,
            )
          ) {
            refuse("VALIDATION_FAILED", adminReasonCodes.promotionInvalid, {
              index,
              field: "imageUrl",
            });
          }
          try {
            defineIntelPromotions([candidate]);
          } catch (error) {
            if (error instanceof InvalidIntelPromotionError) {
              refuse("VALIDATION_FAILED", adminReasonCodes.promotionInvalid, {
                index,
              });
            }
            throw error;
          }
        });
        try {
          items = defineIntelPromotions(candidates);
        } catch (error) {
          if (error instanceof InvalidIntelPromotionError) {
            refuse("VALIDATION_FAILED", adminReasonCodes.promotionInvalid);
          }
          throw error;
        }
      }
      try {
        const written = await repository.writeSetting({
          key: "intel_promotions",
          value: items,
          expectedUpdatedAt: expected,
          audit: {
            actor: context.session.actor,
            actorAccountId: context.session.accountId,
            action: "settings.intel_promotions.update",
            targetType: "setting",
            targetId: "intel_promotions",
            requestId: context.requestId,
          },
        });
        options.settingsReader.invalidate("intel_promotions");
        return Object.freeze({
          ...(await promotionsResource()),
          audit: auditReference(written.audit),
        });
      } catch (error) {
        return translate(error);
      }
    },

    async listCommunities(query) {
      const status = query.status;
      if (
        status !== undefined &&
        status !== "pending" &&
        status !== "verified" &&
        status !== "rejected"
      ) {
        refuse("INVALID_REQUEST");
      }
      const q = optionalQuery(query.q);
      if (query.cursor !== undefined && query.limit !== undefined) {
        refuse("INVALID_REQUEST");
      }
      const filter = `status=${status ?? ""}&q=${q ?? ""}`;
      let limit = parseLimit(query.limit);
      let after: { createdAt: string; communityId: string } | null = null;
      if (query.cursor !== undefined) {
        const payload = decodeCursor("communities", filter, query.cursor);
        if (
          typeof payload["createdAt"] !== "string" ||
          typeof payload["communityId"] !== "string" ||
          !canonicalUuidPattern.test(payload["communityId"]) ||
          typeof payload["limit"] !== "number"
        ) {
          refuse("INVALID_REQUEST");
        }
        after = {
          createdAt: payload["createdAt"],
          communityId: payload["communityId"],
        };
        limit = parseLimit(payload["limit"]);
      }
      try {
        const rows = await repository.listCommunities({
          status: status ?? null,
          query: q,
          limit: limit + 1,
          after,
        });
        const page = rows.slice(0, limit);
        const last = page.at(-1);
        return Object.freeze({
          items: page.map(projectCommunity),
          nextCursor:
            rows.length > limit && last !== undefined
              ? encodeCursor("communities", filter, {
                  createdAt: last.createdAt,
                  communityId: last.communityId,
                  limit,
                })
              : null,
        });
      } catch (error) {
        return translate(error);
      }
    },

    async getCommunity(communityId) {
      if (!canonicalUuidPattern.test(communityId)) {
        refuse("NOT_FOUND", adminReasonCodes.communityNotFound);
      }
      try {
        const community = await repository.getCommunity(communityId);
        if (community === null) {
          refuse("NOT_FOUND", adminReasonCodes.communityNotFound);
        }
        const notes = await repository.listCommunityReviewNotes(communityId);
        return Object.freeze({
          community: projectCommunity(community),
          reviewNotes: notes,
        });
      } catch (error) {
        return translate(error);
      }
    },

    async reviewCommunity(context, communityId, body) {
      if (body.decision !== "verify" && body.decision !== "reject") {
        refuse("INVALID_REQUEST");
      }
      const decision = body.decision;
      const code = reasonCode(body.reasonCode);
      const text = reasonText(body.reasonText, decision === "reject");
      if (!canonicalUuidPattern.test(communityId)) {
        refuse("NOT_FOUND", adminReasonCodes.communityNotFound);
      }
      try {
        const before = await repository.getCommunity(communityId);
        if (before === null) {
          refuse("NOT_FOUND", adminReasonCodes.communityNotFound);
        }
        if (options.communityReview === null) {
          throw new AdminApiError("CAPABILITY_UNAVAILABLE", {
            reasonCode: adminReasonCodes.communityReviewUnavailable,
          });
        }
        const beforeState = {
          verificationStatus: before.verificationStatus,
          rejectedReason: before.rejectedReason,
        };
        // Decision 0105: intent row first; no row, no review.
        const requested = await intentAudit({
          actor: context.session.actor,
          actorAccountId: context.session.accountId,
          action: "community.review.requested",
          targetType: "community",
          targetId: communityId,
          before: beforeState,
          after: { decision, reasonCode: code, reasonText: text },
          requestId: context.requestId,
        });
        let result;
        try {
          result =
            decision === "verify"
              ? await options.communityReview.verify({
                  communityId,
                  requestId: context.requestId,
                  reasonCode: code,
                })
              : await options.communityReview.reject({
                  communityId,
                  requestId: context.requestId,
                  reasonCode: code,
                  reason: text as string,
                });
        } catch (error) {
          const errorCode = (error as { readonly code?: unknown } | null)?.code;
          await outcomeAudit({
            actor: context.session.actor,
            actorAccountId: context.session.accountId,
            action: "community.review.failed",
            targetType: "community",
            targetId: communityId,
            before: beforeState,
            after: {
              decision,
              requestedAuditId: requested.auditId,
              errorCode: typeof errorCode === "string" ? errorCode : "unknown",
            },
            requestId: context.requestId,
          });
          if (errorCode === "community_data_stale") {
            throw new AdminApiError("ADMIN_CONFLICT", {
              reasonCode: adminReasonCodes.communityAlreadyVerified,
            });
          }
          if (errorCode === "community_not_found") {
            throw new AdminApiError("NOT_FOUND", {
              reasonCode: adminReasonCodes.communityNotFound,
            });
          }
          if (errorCode === "community_repository_unavailable") {
            throw new AdminApiError("CAPABILITY_UNAVAILABLE", {
              reasonCode: adminReasonCodes.communityReviewUnavailable,
            });
          }
          throw error;
        }
        const recorded = await repository.recordCommunityReview({
          communityId,
          decision,
          reasonCode: code,
          reasonText: text,
          audit: {
            actor: context.session.actor,
            actorAccountId: context.session.accountId,
            action: "community.review.decided",
            targetType: "community",
            targetId: communityId,
            before: beforeState,
            after: {
              decision,
              requestedAuditId: requested.auditId,
              verificationStatus: result.community.verificationStatus,
              changed: result.changed,
              reasonCode: code,
              reasonText: text,
              notification: result.notification,
              push: result.push.status,
            },
            requestId: context.requestId,
          },
        });
        const after = await repository.getCommunity(communityId);
        return Object.freeze({
          community: projectCommunity(after ?? before),
          changed: result.changed,
          notification: result.notification,
          push: result.push,
          note: recorded.note,
          audit: auditReference(recorded.audit),
        });
      } catch (error) {
        return translate(error);
      }
    },

    async listFormulaVersions() {
      try {
        const versions = await repository.listFormulaVersions();
        return Object.freeze({
          items: versions.map(projectFormulaVersion),
          approvedVersion:
            versions.find((version) => version.status === "approved")
              ?.configVersion ?? null,
          approval: formulaApprovalState(),
        });
      } catch (error) {
        return translate(error);
      }
    },

    async createFormulaDraft(context, body) {
      if (
        typeof body.configVersion !== "string" ||
        !configVersionPattern.test(body.configVersion) ||
        typeof body.baseVersion !== "string" ||
        !configVersionPattern.test(body.baseVersion)
      ) {
        refuse("INVALID_REQUEST");
      }
      const parameters = parseFormulaParameters(body.parameters);
      try {
        const base = await repository.getFormulaVersion(body.baseVersion);
        if (base === null) {
          refuse("VALIDATION_FAILED", adminReasonCodes.formulaNotFound, {
            field: "baseVersion",
          });
        }
        const draft = await buildDraft(base, parameters);
        const created = await repository.createFormulaDraft({
          configVersion: body.configVersion,
          formula: draft.formula,
          weightRange: draft.weightRange,
          priceGuardRules: base.priceGuardRules,
          communityWeights: draft.communityWeights,
          // Decision 0110: the author is stored with the draft; the
          // approver must be someone else.
          author:
            context.session.accountId === null
              ? {
                  kind: "admin_bootstrap",
                  actor: context.session.actor,
                  accountId: null,
                }
              : {
                  kind: "admin_account",
                  actor: context.session.actor,
                  accountId: context.session.accountId,
                },
          audit: {
            actor: context.session.actor,
            actorAccountId: context.session.accountId,
            action: "mining.formula.draft",
            targetType: "mining_formula_version",
            targetId: body.configVersion,
            requestId: context.requestId,
          },
        });
        return Object.freeze({
          version: projectFormulaVersion(created.version),
          baseVersion: base.configVersion,
          audit: auditReference(created.audit),
        });
      } catch (error) {
        return translate(error);
      }
    },

    async approveFormula(context, configVersion) {
      // Decision 0110: only a role holding `formula.approve` (reviewer)
      // approves, always as a console account (the route checked it too).
      const approverAccountId = context.session.accountId;
      if (
        !adminRoleHasPermission(context.session.role, "formula.approve") ||
        approverAccountId === null
      ) {
        throw new AdminApiError("PERMISSION_DENIED", {
          reasonCode: adminReasonCodes.roleForbidden,
          permission: "formula.approve",
        });
      }
      if (!configVersionPattern.test(configVersion)) {
        refuse("NOT_FOUND", adminReasonCodes.formulaNotFound);
      }
      const approval = formulaApprovalState();
      if (!approval.available) {
        throw new AdminApiError("CAPABILITY_UNAVAILABLE", {
          reasonCode: approval.reasonCode,
        });
      }
      const auditBase = {
        actor: context.session.actor,
        actorAccountId: approverAccountId,
        targetType: "mining_formula_version",
        targetId: configVersion,
        requestId: context.requestId,
      } as const;
      // Decision 0110 (0105 / 0109 pattern): the intent row first; when it
      // cannot be written nothing is approved (503 ADMIN_AUDIT_UNAVAILABLE).
      const requested = await intentAudit({
        ...auditBase,
        action: "mining.formula.approve.requested",
        before: null,
        after: { configVersion },
      });
      try {
        const approved = await repository.approveFormula({
          configVersion,
          approver: {
            actor: context.session.actor,
            accountId: approverAccountId,
          },
          requestedAuditId: requested.auditId,
          audit: { ...auditBase, action: "mining.formula.approve" },
        });
        return Object.freeze({
          version: projectFormulaVersion(approved.version),
          retiredVersion: approved.retiredVersion,
          audit: auditReference(approved.audit),
        });
      } catch (error) {
        const reason =
          error instanceof AdminStateConflictError ||
          error instanceof AdminValidationError ||
          error instanceof AdminTargetNotFoundError ||
          error instanceof AdminSeparationOfDutiesError
            ? error.reasonCode
            : error instanceof AdminRepositoryUnavailableError
              ? adminReasonCodes.databaseUnavailable
              : "INTERNAL";
        await outcomeAudit({
          ...auditBase,
          action: "mining.formula.approve.failed",
          before: null,
          after: { reasonCode: reason, requestedAuditId: requested.auditId },
        });
        return translate(error);
      }
    },

    async withdrawFormula(context, configVersion) {
      if (!configVersionPattern.test(configVersion)) {
        refuse("NOT_FOUND", adminReasonCodes.formulaNotFound);
      }
      try {
        const withdrawn = await repository.withdrawFormula({
          configVersion,
          audit: {
            actor: context.session.actor,
            actorAccountId: context.session.accountId,
            action: "mining.formula.withdraw",
            targetType: "mining_formula_version",
            targetId: configVersion,
            requestId: context.requestId,
          },
        });
        return Object.freeze({
          version: projectFormulaVersion(withdrawn.version),
          audit: auditReference(withdrawn.audit),
        });
      } catch (error) {
        return translate(error);
      }
    },

    async listMemeTokens(query) {
      const status = query.status;
      if (
        status !== undefined &&
        (typeof status !== "string" ||
          ![
            "draft",
            "pending_chain",
            "trading",
            "full",
            "graduated",
            "paused",
          ].includes(status))
      ) {
        refuse("INVALID_REQUEST");
      }
      const listing = query.listing;
      if (
        listing !== undefined &&
        listing !== "listed" &&
        listing !== "hidden"
      ) {
        refuse("INVALID_REQUEST");
      }
      const q = optionalQuery(query.q);
      if (query.cursor !== undefined && query.limit !== undefined) {
        refuse("INVALID_REQUEST");
      }
      const filter = `status=${status ?? ""}&listing=${listing ?? ""}&q=${q ?? ""}`;
      let limit = parseLimit(query.limit);
      let after: { createdAt: string; memeTokenId: string } | null = null;
      if (query.cursor !== undefined) {
        const payload = decodeCursor("memeTokens", filter, query.cursor);
        if (
          typeof payload["createdAt"] !== "string" ||
          typeof payload["memeTokenId"] !== "string" ||
          !canonicalUuidPattern.test(payload["memeTokenId"]) ||
          typeof payload["limit"] !== "number"
        ) {
          refuse("INVALID_REQUEST");
        }
        after = {
          createdAt: payload["createdAt"],
          memeTokenId: payload["memeTokenId"],
        };
        limit = parseLimit(payload["limit"]);
      }
      try {
        const rows = await repository.listMemeTokens({
          status: status ?? null,
          listing: listing ?? null,
          query: q,
          limit: limit + 1,
          after,
        });
        const page = rows.slice(0, limit);
        const last = page.at(-1);
        return Object.freeze({
          items: page.map(projectMeme),
          nextCursor:
            rows.length > limit && last !== undefined
              ? encodeCursor("memeTokens", filter, {
                  createdAt: last.createdAt,
                  memeTokenId: last.memeTokenId,
                  limit,
                })
              : null,
          pause: memePauseState(),
        });
      } catch (error) {
        return translate(error);
      }
    },

    async setMemeListing(context, memeTokenId, body) {
      if (body.listing !== "listed" && body.listing !== "hidden") {
        refuse("INVALID_REQUEST");
      }
      const listing = body.listing;
      const code = reasonCode(body.reasonCode);
      const text = reasonText(body.reasonText, listing === "hidden");
      if (!canonicalUuidPattern.test(memeTokenId)) {
        refuse("NOT_FOUND", adminReasonCodes.memeTokenNotFound);
      }
      try {
        const updated = await repository.setMemeListing({
          memeTokenId,
          listing,
          reasonCode: code,
          reasonText: text,
          audit: {
            actor: context.session.actor,
            actorAccountId: context.session.accountId,
            action: "meme.listing.update",
            targetType: "meme_token",
            targetId: memeTokenId,
            requestId: context.requestId,
          },
        });
        return Object.freeze({
          memeToken: projectMeme(updated.token),
          changed: updated.changed,
          audit: auditReference(updated.audit),
        });
      } catch (error) {
        return translate(error);
      }
    },

    async listLaunch2Instances(query) {
      const listing = query.listing;
      if (
        listing !== undefined &&
        listing !== "visible" &&
        listing !== "hidden"
      ) {
        refuse("INVALID_REQUEST");
      }
      const q = optionalQuery(query.q);
      try {
        const rows = await repository.listLaunch2Instances({
          listing: listing ?? null,
          query: q,
          limit: adminLaunch2ListingListLimit,
        });
        return Object.freeze({ items: rows });
      } catch (error) {
        return translate(error);
      }
    },

    async setLaunch2Listing(context, instanceId, body) {
      if (body.listing !== "visible" && body.listing !== "hidden") {
        refuse("INVALID_REQUEST");
      }
      const listing = body.listing;
      const reason = reasonText(body.reason, listing === "hidden");
      if (!canonicalUuidPattern.test(instanceId)) {
        refuse("NOT_FOUND", adminReasonCodes.launch2InstanceNotFound);
      }
      try {
        const updated = await repository.setLaunch2Listing({
          instanceId,
          listing,
          reason,
          audit: {
            actor: context.session.actor,
            actorAccountId: context.session.accountId,
            action: "launch2.listing.update",
            targetType: "launch2_instance",
            targetId: instanceId,
            requestId: context.requestId,
          },
        });
        return Object.freeze({
          instance: updated.instance,
          changed: updated.changed,
          audit: auditReference(updated.audit),
        });
      } catch (error) {
        return translate(error);
      }
    },

    async pauseMeme(context, memeTokenId, action, body) {
      const code = reasonCode(body.reasonCode);
      const text = reasonText(body.reasonText, false);
      if (!canonicalUuidPattern.test(memeTokenId)) {
        refuse("NOT_FOUND", adminReasonCodes.memeTokenNotFound);
      }
      if (options.memePause.status === "unavailable") {
        throw new AdminApiError("CAPABILITY_UNAVAILABLE", {
          reasonCode: options.memePause.reasonCode,
        });
      }
      const sender = options.memePause.sender;
      try {
        const token = await repository.getMemeToken(memeTokenId);
        if (token === null) {
          refuse("NOT_FOUND", adminReasonCodes.memeTokenNotFound);
        }
        if (token.tokenAddress === null) {
          throw new AdminApiError("ADMIN_CONFLICT", {
            reasonCode: adminReasonCodes.memeTokenNotOnChain,
          });
        }
        // Decision 0105: claimed synchronously after the last await, so two
        // concurrent requests for one token can never both reach the signer.
        if (pauseInFlight.has(memeTokenId)) {
          throw new AdminApiError("ADMIN_CONFLICT", {
            reasonCode: adminReasonCodes.memePausePending,
          });
        }
        pauseInFlight.add(memeTokenId);
        try {
          await assertNoPendingPause(memeTokenId);
          const admissible =
            action === "pause"
              ? token.status === "trading" || token.status === "full"
              : token.status === "paused";
          if (!admissible) {
            throw new AdminApiError("ADMIN_CONFLICT", {
              reasonCode: adminReasonCodes.memePauseState,
              status: token.status,
            });
          }
          return await submitPause(token.tokenAddress, token.status);
        } finally {
          pauseInFlight.delete(memeTokenId);
        }
      } catch (error) {
        return translate(error);
      }

      async function submitPause(
        tokenAddress: string,
        status: string,
      ): Promise<Record<string, unknown>> {
        const base = {
          actor: context.session.actor,
          actorAccountId: context.session.accountId,
          targetType: "meme_token",
          targetId: memeTokenId,
          before: { status },
          requestId: context.requestId,
        } as const;
        // Decision 0105: intent row first; no row, nothing is signed.
        const requested = await intentAudit({
          ...base,
          action: `meme.${action}.requested`,
          after: {
            reasonCode: code,
            reasonText: text,
            executorAddress: sender.address,
          },
        });
        const failed = (errorCode: string) =>
          outcomeAudit({
            ...base,
            action: `meme.${action}.failed`,
            after: {
              requestedAuditId: requested.auditId,
              errorCode,
              executorAddress: sender.address,
            },
          });
        let outcome;
        try {
          outcome = await sender.submit(action, tokenAddress);
        } catch (error) {
          await failed(adminReasonCodes.memePauseBroadcastFailed);
          throw error;
        }
        if (outcome.status === "simulation_reverted") {
          await failed(adminReasonCodes.memePauseSimulationReverted);
          throw new AdminApiError("ADMIN_CONFLICT", {
            reasonCode: adminReasonCodes.memePauseSimulationReverted,
          });
        }
        if (outcome.status === "failed") {
          const row = await failed(outcome.errorCode);
          throw new AdminApiError("CAPABILITY_UNAVAILABLE", {
            reasonCode: outcome.errorCode,
            auditId: row?.auditId ?? requested.auditId,
          });
        }
        pausePending.set(memeTokenId, {
          transactionHash: outcome.transactionHash,
          submittedAtMs: now().getTime(),
        });
        const submitted = await outcomeAudit({
          ...base,
          action: `meme.${action}.submitted`,
          after: {
            requestedAuditId: requested.auditId,
            transactionHash: outcome.transactionHash,
            reasonCode: code,
            reasonText: text,
            executorAddress: sender.address,
          },
        });
        return Object.freeze({
          memeTokenId,
          action,
          status: "submitted",
          transactionHash: outcome.transactionHash,
          executorAddress: sender.address,
          audit: auditReference(submitted ?? requested),
        });
      }
    },

    async listAudit(query) {
      const actor = optionalQuery(query.actor);
      const action = optionalQuery(query.action);
      if (query.cursor !== undefined && query.limit !== undefined) {
        refuse("INVALID_REQUEST");
      }
      const filter = `actor=${actor ?? ""}&action=${action ?? ""}`;
      let limit = parseLimit(query.limit);
      let beforeSeq: number | null = null;
      if (query.cursor !== undefined) {
        const payload = decodeCursor("audit", filter, query.cursor);
        if (
          typeof payload["seq"] !== "number" ||
          !Number.isSafeInteger(payload["seq"]) ||
          typeof payload["limit"] !== "number"
        ) {
          refuse("INVALID_REQUEST");
        }
        beforeSeq = payload["seq"];
        limit = parseLimit(payload["limit"]);
      }
      try {
        const rows = await repository.listAudit({
          limit: limit + 1,
          beforeSeq,
          actor,
          action,
        });
        const page = rows.slice(0, limit);
        const last = page.at(-1);
        return Object.freeze({
          items: page.map(projectAudit),
          nextCursor:
            rows.length > limit && last !== undefined
              ? encodeCursor("audit", filter, { seq: last.seq, limit })
              : null,
        });
      } catch (error) {
        return translate(error);
      }
    },
  };
  return Object.freeze(service);
}
