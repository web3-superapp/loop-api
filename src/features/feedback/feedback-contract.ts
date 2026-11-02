import { createHash } from "node:crypto";

/**
 * Beta feedback contract (Decision 0193, 主代理决策 0262, docs/52 §二).
 * A report is a category, a text body, up to four screenshots uploaded
 * through `POST /v2/media/feedback-images`, and a small client environment
 * block. Reports are read back by their author (`GET /v2/feedback/mine`)
 * and triaged in the operator console (`/admin/v1/feedback`).
 */

export const feedbackCategories = Object.freeze([
  "bug",
  "suggestion",
  "other",
] as const);
export type FeedbackCategory = (typeof feedbackCategories)[number];

export const feedbackStatuses = Object.freeze([
  "open",
  "triaged",
  "resolved",
  "wont_fix",
] as const);
export type FeedbackStatus = (typeof feedbackStatuses)[number];

/** The only `context` keys kept; any other key is dropped. */
export const feedbackContextKeys = Object.freeze([
  "appVersion",
  "build",
  "platform",
  "osVersion",
  "deviceModel",
  "route",
  "locale",
] as const);
export type FeedbackContextKey = (typeof feedbackContextKeys)[number];
export type FeedbackContext = Readonly<
  Partial<Record<FeedbackContextKey, string>>
>;

export const feedbackLimits = Object.freeze({
  /** Code points after trim. */
  bodyMax: 2_000,
  imagesMax: 4,
  /** Reports per account in a rolling 24 hours. */
  dailyMax: 20,
  dailyWindowMs: 24 * 60 * 60 * 1_000,
  /** A screenshot must have been uploaded at most this long ago. */
  mediaFreshMs: 24 * 60 * 60 * 1_000,
  /** Code points kept per context value (longer values are cut). */
  contextValueMax: 200,
  minePageSize: 20,
  adminPageDefault: 20,
  adminPageMax: 100,
  adminNoteMax: 1_000,
});

/** `detailsSafe.reasonCode` values. */
export const feedbackReasonCodes = Object.freeze({
  disabled: "BETA_FEEDBACK_DISABLED",
  repositoryUnavailable: "FEEDBACK_REPOSITORY_UNAVAILABLE",
  bodyEmpty: "FEEDBACK_BODY_EMPTY",
  bodyTooLong: "FEEDBACK_BODY_TOO_LONG",
  bodyInvalid: "FEEDBACK_BODY_INVALID",
  tooManyImages: "FEEDBACK_TOO_MANY_IMAGES",
  mediaDuplicate: "FEEDBACK_MEDIA_DUPLICATE",
  mediaNotOwned: "MEDIA_NOT_OWNED",
  mediaInUse: "FEEDBACK_MEDIA_IN_USE",
  dailyLimit: "FEEDBACK_DAILY_LIMIT",
  notFound: "FEEDBACK_NOT_FOUND",
  adminNoteTooLong: "FEEDBACK_ADMIN_NOTE_TOO_LONG",
  adminNoteInvalid: "FEEDBACK_ADMIN_NOTE_INVALID",
} as const);

const uuidPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;

export function isFeedbackUuid(value: unknown): value is string {
  return typeof value === "string" && uuidPattern.test(value);
}

export function isFeedbackCategory(value: unknown): value is FeedbackCategory {
  return (
    typeof value === "string" &&
    (feedbackCategories as readonly string[]).includes(value)
  );
}

export function isFeedbackStatus(value: unknown): value is FeedbackStatus {
  return (
    typeof value === "string" &&
    (feedbackStatuses as readonly string[]).includes(value)
  );
}

function codePoints(value: string): number {
  return [...value].length;
}

/**
 * Body text: CRLF / CR become LF, then trimmed; 1..2000 code points; NUL
 * (which PostgreSQL text cannot hold) is refused. Everything else a user
 * can paste (tabs, emoji, other scripts) is kept as is.
 */
export function checkFeedbackBody(
  value: unknown,
):
  | { readonly ok: true; readonly body: string }
  | { readonly ok: false; readonly reasonCode: string } {
  if (typeof value !== "string") {
    return { ok: false, reasonCode: feedbackReasonCodes.bodyEmpty };
  }
  const body = value.replace(/\r\n?/gu, "\n").trim();
  if (body.length === 0) {
    return { ok: false, reasonCode: feedbackReasonCodes.bodyEmpty };
  }
  if (body.includes("\u0000")) {
    return { ok: false, reasonCode: feedbackReasonCodes.bodyInvalid };
  }
  if (codePoints(body) > feedbackLimits.bodyMax) {
    return { ok: false, reasonCode: feedbackReasonCodes.bodyTooLong };
  }
  return { ok: true, body };
}

/**
 * Keeps only the seven known keys. A string value is trimmed (control
 * characters removed) and cut to 200 code points; a finite number becomes
 * its decimal string (a client may send `build` as an integer); empty
 * strings and every other value type are dropped. A non-object context is
 * an empty context.
 */
export function normalizeFeedbackContext(value: unknown): FeedbackContext {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return Object.freeze({});
  }
  const source = value as Record<string, unknown>;
  const result: Partial<Record<FeedbackContextKey, string>> = {};
  for (const key of feedbackContextKeys) {
    if (!Object.prototype.hasOwnProperty.call(source, key)) continue;
    const raw = source[key];
    let text: string | null = null;
    if (typeof raw === "string") {
      text = raw;
    } else if (typeof raw === "number" && Number.isFinite(raw)) {
      text = String(raw);
    }
    if (text === null) continue;
    // eslint-disable-next-line no-control-regex
    const cleaned = text.replace(/[\u0000-\u001f\u007f]/gu, "").trim();
    if (cleaned.length === 0) continue;
    result[key] = [...cleaned]
      .slice(0, feedbackLimits.contextValueMax)
      .join("");
  }
  return Object.freeze(result);
}

/** Admin note: trimmed, 1..1000 code points, no NUL; empty clears (null). */
export function checkFeedbackAdminNote(
  value: unknown,
):
  | { readonly ok: true; readonly note: string | null }
  | { readonly ok: false; readonly reasonCode: string } {
  if (value === null) return { ok: true, note: null };
  if (typeof value !== "string") {
    return { ok: false, reasonCode: feedbackReasonCodes.adminNoteInvalid };
  }
  const note = value.replace(/\r\n?/gu, "\n").trim();
  if (note.length === 0) return { ok: true, note: null };
  if (note.includes("\u0000")) {
    return { ok: false, reasonCode: feedbackReasonCodes.adminNoteInvalid };
  }
  if (codePoints(note) > feedbackLimits.adminNoteMax) {
    return { ok: false, reasonCode: feedbackReasonCodes.adminNoteTooLong };
  }
  return { ok: true, note };
}

/** SHA-256 of the normalized create request (bound to the Idempotency-Key). */
export function feedbackCreateDigest(input: {
  readonly category: FeedbackCategory;
  readonly body: string;
  readonly mediaIds: readonly string[];
  readonly context: FeedbackContext;
}): string {
  const context = feedbackContextKeys.map((key) => input.context[key] ?? null);
  return createHash("sha256")
    .update(
      JSON.stringify([
        "beta-feedback-v1",
        input.category,
        input.body,
        input.mediaIds,
        context,
      ]),
    )
    .digest("hex");
}

/** One stored report (repository → services). */
export interface FeedbackRecord {
  readonly id: string;
  readonly accountId: string;
  /** The reporter's LOOP ID; null when the account has none. */
  readonly loopId: string | null;
  /** The reporter's profile alias; null without a profile / alias. */
  readonly displayName: string | null;
  readonly category: FeedbackCategory;
  readonly body: string;
  readonly context: FeedbackContext;
  readonly status: FeedbackStatus;
  readonly adminNote: string | null;
  /** Attached screenshots in `sort` order. */
  readonly mediaIds: readonly string[];
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface FeedbackPageKey {
  readonly createdAt: string;
  readonly id: string;
}

export interface FeedbackAuditInput {
  readonly actor: string;
  readonly actorAccountId: string | null;
  readonly requestId: string;
}

export interface FeedbackAuditRef {
  readonly auditId: string;
  readonly seq: number;
  readonly at: string;
}

export type FeedbackCreateResult =
  | { readonly status: "created" | "replayed"; readonly record: FeedbackRecord }
  | { readonly status: "conflict" }
  | { readonly status: "rate_limited" }
  | {
      readonly status: "media_rejected";
      readonly reasonCode: string;
      readonly mediaId: string;
    };

export type FeedbackAdminUpdateResult =
  | { readonly status: "not_found" }
  | {
      readonly status: "written";
      readonly record: FeedbackRecord;
      readonly audit: FeedbackAuditRef;
    };

export interface FeedbackRepository {
  /**
   * In one transaction holding the account lock: an earlier report with
   * this Idempotency-Key replays (same digest) or conflicts; otherwise the
   * rolling daily limit, then every media ID must be the account's own
   * `feedback_image` uploaded after `mediaFreshSince` and attached nowhere;
   * then the report and its attachments are inserted.
   */
  create(input: {
    readonly id: string;
    readonly accountId: string;
    readonly category: FeedbackCategory;
    readonly body: string;
    readonly context: FeedbackContext;
    readonly mediaIds: readonly string[];
    readonly idempotency: {
      readonly key: string;
      readonly requestSha256: string;
    };
    readonly now: Date;
    readonly dailyMax: number;
    readonly windowMs: number;
    readonly mediaFreshSince: Date;
  }): Promise<FeedbackCreateResult>;
  /** The account's reports, newest first, strictly before `before`. */
  listMine(input: {
    readonly accountId: string;
    readonly before: FeedbackPageKey | null;
    readonly limit: number;
  }): Promise<readonly FeedbackRecord[]>;
  /** Every report (or one status / category), newest first. */
  adminList(input: {
    readonly status: FeedbackStatus | null;
    readonly category: FeedbackCategory | null;
    readonly before: FeedbackPageKey | null;
    readonly limit: number;
  }): Promise<readonly FeedbackRecord[]>;
  adminGet(id: string): Promise<FeedbackRecord | null>;
  /**
   * Locks the row, applies `status` / `adminNote` (undefined = keep), and
   * writes the `beta_feedback.update` audit row in the same transaction.
   */
  adminUpdate(input: {
    readonly id: string;
    readonly status: FeedbackStatus | undefined;
    readonly adminNote: string | null | undefined;
    readonly now: Date;
    readonly audit: FeedbackAuditInput;
  }): Promise<FeedbackAdminUpdateResult>;
}
