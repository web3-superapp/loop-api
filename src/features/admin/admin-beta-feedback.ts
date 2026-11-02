import { createHmac, timingSafeEqual } from "node:crypto";

import {
  checkFeedbackAdminNote,
  feedbackLimits,
  feedbackReasonCodes,
  isFeedbackCategory,
  isFeedbackStatus,
  isFeedbackUuid,
  type FeedbackAuditRef,
  type FeedbackCategory,
  type FeedbackPageKey,
  type FeedbackRecord,
  type FeedbackRepository,
  type FeedbackStatus,
} from "../feedback/feedback-contract.js";
import { feedbackImageUrls } from "../feedback/feedback-service.js";
import { AdminApiError } from "./admin-contract.js";
import type { AdminWriteContext } from "./admin-service.js";

/**
 * Decision 0193 (主代理决策 0262): the console side of beta feedback under
 * `/admin/v1/feedback` — list / get (console.read, or launch.approve for
 * the reviewer) and update status / note (console.write, or
 * launch.approve). Each update writes `admin_audit_log`
 * `beta_feedback.update` (target `beta_feedback`) in its transaction. The
 * BETA_FEEDBACK_ENABLED switch does not close the console. Without the
 * database: 503 CAPABILITY_UNAVAILABLE / FEEDBACK_REPOSITORY_UNAVAILABLE.
 */

export interface AdminFeedbackResource {
  readonly id: string;
  readonly accountId: string;
  readonly account: {
    readonly loopId: string | null;
    readonly displayName: string | null;
  };
  readonly category: FeedbackCategory;
  readonly body: string;
  readonly status: FeedbackStatus;
  readonly adminNote: string | null;
  readonly images: readonly string[];
  readonly context: Readonly<Record<string, string>>;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface AdminFeedbackService {
  list(query: Record<string, unknown>): Promise<{
    readonly items: readonly AdminFeedbackResource[];
    readonly nextCursor: string | null;
  }>;
  get(id: string): Promise<{ readonly feedback: AdminFeedbackResource }>;
  update(
    context: AdminWriteContext,
    id: string,
    body: unknown,
  ): Promise<{
    readonly feedback: AdminFeedbackResource;
    readonly audit: FeedbackAuditRef;
  }>;
}

export function createAdminFeedbackService(input: {
  readonly repository: FeedbackRepository | null;
  readonly publicBaseUrl: string;
  /** Signs list cursors (the console session secret); null = no paging. */
  readonly cursorSecret: string | null;
  readonly now?: () => Date;
}): AdminFeedbackService {
  const now = input.now ?? ((): Date => new Date());
  const cursorKey =
    input.cursorSecret === null
      ? null
      : createHmac("sha256", "loop-admin-beta-feedback-cursor-v1")
          .update(input.cursorSecret)
          .digest();
  const unavailable = (): AdminApiError =>
    new AdminApiError("CAPABILITY_UNAVAILABLE", {
      reasonCode: feedbackReasonCodes.repositoryUnavailable,
    });
  const notFound = (): AdminApiError =>
    new AdminApiError("NOT_FOUND", {
      reasonCode: feedbackReasonCodes.notFound,
    });

  function repository(): FeedbackRepository {
    if (input.repository === null) throw unavailable();
    return input.repository;
  }

  async function guarded<T>(operation: () => Promise<T>): Promise<T> {
    try {
      return await operation();
    } catch (error) {
      if (error instanceof AdminApiError) throw error;
      throw unavailable();
    }
  }

  function encodeCursor(
    filter: string,
    key: FeedbackPageKey & { readonly limit: number },
  ): string | null {
    if (cursorKey === null) return null;
    const body = Buffer.from(JSON.stringify({ f: filter, p: key })).toString(
      "base64url",
    );
    const mac = createHmac("sha256", cursorKey)
      .update(body)
      .digest("base64url");
    return `${body}.${mac}`;
  }

  function decodeCursor(
    filter: string,
    cursor: unknown,
  ): FeedbackPageKey & { readonly limit: number } {
    if (cursorKey === null) throw new AdminApiError("INVALID_REQUEST");
    if (typeof cursor !== "string" || cursor.length > 1_024) {
      throw new AdminApiError("INVALID_REQUEST");
    }
    const [body, mac, extra] = cursor.split(".");
    if (body === undefined || mac === undefined || extra !== undefined) {
      throw new AdminApiError("INVALID_REQUEST");
    }
    const expected = Buffer.from(
      createHmac("sha256", cursorKey).update(body).digest("base64url"),
    );
    const given = Buffer.from(mac);
    if (expected.length !== given.length || !timingSafeEqual(expected, given)) {
      throw new AdminApiError("INVALID_REQUEST");
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(Buffer.from(body, "base64url").toString("utf8"));
    } catch {
      throw new AdminApiError("INVALID_REQUEST");
    }
    if (typeof parsed !== "object" || parsed === null) {
      throw new AdminApiError("INVALID_REQUEST");
    }
    const record = parsed as { f?: unknown; p?: unknown };
    const payload = record.p as Record<string, unknown> | null | undefined;
    if (
      record.f !== filter ||
      typeof payload !== "object" ||
      payload === null ||
      typeof payload["createdAt"] !== "string" ||
      Number.isNaN(Date.parse(payload["createdAt"])) ||
      !isFeedbackUuid(payload["id"]) ||
      typeof payload["limit"] !== "number" ||
      !Number.isInteger(payload["limit"]) ||
      payload["limit"] < 1 ||
      payload["limit"] > feedbackLimits.adminPageMax
    ) {
      throw new AdminApiError("INVALID_REQUEST");
    }
    return {
      createdAt: payload["createdAt"],
      id: payload["id"],
      limit: payload["limit"],
    };
  }

  function resource(record: FeedbackRecord): AdminFeedbackResource {
    return Object.freeze({
      id: record.id,
      accountId: record.accountId,
      account: Object.freeze({
        loopId: record.loopId,
        displayName: record.displayName,
      }),
      category: record.category,
      body: record.body,
      status: record.status,
      adminNote: record.adminNote,
      images: feedbackImageUrls(input.publicBaseUrl, record),
      context: Object.freeze({ ...record.context }),
      createdAt: record.createdAt,
      updatedAt: record.updatedAt,
    });
  }

  return Object.freeze({
    async list(query: Record<string, unknown>) {
      const store = repository();
      const status = query["status"];
      const category = query["category"];
      if (status !== undefined && !isFeedbackStatus(status)) {
        throw new AdminApiError("INVALID_REQUEST");
      }
      if (category !== undefined && !isFeedbackCategory(category)) {
        throw new AdminApiError("INVALID_REQUEST");
      }
      if (query["cursor"] !== undefined && query["limit"] !== undefined) {
        throw new AdminApiError("INVALID_REQUEST");
      }
      const filter = `status=${String(status ?? "")}&category=${String(category ?? "")}`;
      let before: FeedbackPageKey | null = null;
      let limit: number = feedbackLimits.adminPageDefault;
      if (query["cursor"] !== undefined) {
        const decoded = decodeCursor(filter, query["cursor"]);
        before = { createdAt: decoded.createdAt, id: decoded.id };
        limit = decoded.limit;
      } else if (query["limit"] !== undefined) {
        const raw = query["limit"];
        if (
          typeof raw !== "number" ||
          !Number.isInteger(raw) ||
          raw < 1 ||
          raw > feedbackLimits.adminPageMax
        ) {
          throw new AdminApiError("INVALID_REQUEST");
        }
        limit = raw;
      }
      const records = await guarded(() =>
        store.adminList({
          status: status ?? null,
          category: category ?? null,
          before,
          limit: limit + 1,
        }),
      );
      const page = records.slice(0, limit);
      const last = page.at(-1);
      return Object.freeze({
        items: page.map(resource),
        nextCursor:
          records.length > limit && last !== undefined
            ? encodeCursor(filter, {
                createdAt: last.createdAt,
                id: last.id,
                limit,
              })
            : null,
      });
    },

    async get(id: string) {
      const store = repository();
      if (!isFeedbackUuid(id)) throw notFound();
      const record = await guarded(() => store.adminGet(id));
      if (record === null) throw notFound();
      return Object.freeze({ feedback: resource(record) });
    },

    async update(context: AdminWriteContext, id: string, body: unknown) {
      const store = repository();
      if (typeof body !== "object" || body === null || Array.isArray(body)) {
        throw new AdminApiError("INVALID_REQUEST");
      }
      const raw = body as Record<string, unknown>;
      const keys = Object.keys(raw);
      if (
        keys.length === 0 ||
        keys.some((key) => key !== "status" && key !== "adminNote")
      ) {
        throw new AdminApiError("INVALID_REQUEST");
      }
      let status: FeedbackStatus | undefined;
      if (raw["status"] !== undefined) {
        if (!isFeedbackStatus(raw["status"])) {
          throw new AdminApiError("INVALID_REQUEST");
        }
        status = raw["status"];
      }
      let adminNote: string | null | undefined;
      if (Object.prototype.hasOwnProperty.call(raw, "adminNote")) {
        const checked = checkFeedbackAdminNote(raw["adminNote"]);
        if (!checked.ok) {
          throw new AdminApiError("VALIDATION_FAILED", {
            reasonCode: checked.reasonCode,
            field: "adminNote",
          });
        }
        adminNote = checked.note;
      }
      if (!isFeedbackUuid(id)) throw notFound();
      const result = await guarded(() =>
        store.adminUpdate({
          id,
          status,
          adminNote,
          now: now(),
          audit: {
            actor: context.session.actor,
            actorAccountId: context.session.accountId,
            requestId: context.requestId,
          },
        }),
      );
      if (result.status === "not_found") throw notFound();
      return Object.freeze({
        feedback: resource(result.record),
        audit: Object.freeze({ ...result.audit }),
      });
    },
  });
}
