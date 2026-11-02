import { randomUUID } from "node:crypto";

import type { AuthenticatedLoopPrincipal } from "../../core/http/authentication.js";
import {
  InvalidV2CursorError,
  type V2CursorCodec,
} from "../../core/http/v2-cursor.js";
import { V2ApiError } from "../../core/http/v2-error.js";
import { mediaAbsoluteUrl } from "../media/media-contract.js";
import type { MediaService } from "../media/media-service.js";
import {
  checkFeedbackBody,
  feedbackCreateDigest,
  feedbackLimits,
  feedbackReasonCodes,
  isFeedbackCategory,
  isFeedbackUuid,
  normalizeFeedbackContext,
  type FeedbackPageKey,
  type FeedbackRecord,
  type FeedbackRepository,
} from "./feedback-contract.js";

/**
 * Decision 0193 (主代理决策 0262): the App side of beta feedback — the
 * screenshot upload, the report, and the caller's own list. Behind
 * BETA_FEEDBACK_ENABLED (default on): off, every call is 503
 * CAPABILITY_UNAVAILABLE / BETA_FEEDBACK_DISABLED. Without the database or
 * the cursor secret: 503 CAPABILITY_UNAVAILABLE /
 * FEEDBACK_REPOSITORY_UNAVAILABLE (never an empty list).
 */

export interface FeedbackImageUploadResource {
  readonly mediaId: string;
  /** Absolute `<PUBLIC_BASE_URL>/v2/media/<id>.webp`. */
  readonly url: string;
}

export interface FeedbackCreatedResource {
  readonly feedback: {
    readonly id: string;
    readonly status: string;
    readonly createdAt: string;
  };
}

export interface FeedbackMineItem {
  readonly id: string;
  readonly category: string;
  readonly body: string;
  readonly status: string;
  readonly createdAt: string;
  readonly images: readonly string[];
}

export interface FeedbackMineResource {
  readonly items: readonly FeedbackMineItem[];
  readonly nextCursor: string | null;
}

export interface FeedbackService {
  uploadImage(input: {
    readonly principal: AuthenticatedLoopPrincipal;
    readonly idempotencyKey: string;
    readonly readBytes: () => Promise<Buffer>;
  }): Promise<FeedbackImageUploadResource>;
  submit(input: {
    readonly principal: AuthenticatedLoopPrincipal;
    readonly idempotencyKey: string;
    readonly body: unknown;
  }): Promise<{
    readonly replayed: boolean;
    readonly resource: FeedbackCreatedResource;
  }>;
  listMine(input: {
    readonly principal: AuthenticatedLoopPrincipal;
    readonly cursor: unknown;
  }): Promise<FeedbackMineResource>;
}

const cursorRoute = "v2FeedbackMine";
const cursorFilter = "mine";

function validation(reasonCode: string, field: string): V2ApiError {
  return V2ApiError.fromCode("VALIDATION_FAILED", { reasonCode, field });
}

export function feedbackImageUrls(
  publicBaseUrl: string,
  record: Pick<FeedbackRecord, "mediaIds">,
): readonly string[] {
  return Object.freeze(
    record.mediaIds.map((mediaId) => mediaAbsoluteUrl(publicBaseUrl, mediaId)),
  );
}

export function createFeedbackService(input: {
  readonly enabled: boolean;
  readonly repository: FeedbackRepository | null;
  readonly cursorCodec: V2CursorCodec | null;
  readonly media: MediaService | null;
  readonly publicBaseUrl: string;
  readonly now?: () => Date;
  readonly createUuid?: () => string;
}): FeedbackService {
  const now = input.now ?? ((): Date => new Date());
  const createUuid = input.createUuid ?? randomUUID;
  const unavailable = (): V2ApiError =>
    V2ApiError.fromCode("CAPABILITY_UNAVAILABLE", {
      reasonCode: feedbackReasonCodes.repositoryUnavailable,
    });

  function assertEnabled(): void {
    if (!input.enabled) {
      throw V2ApiError.fromCode("CAPABILITY_UNAVAILABLE", {
        reasonCode: feedbackReasonCodes.disabled,
      });
    }
  }

  function repository(): FeedbackRepository {
    assertEnabled();
    if (input.repository === null) throw unavailable();
    return input.repository;
  }

  async function guarded<T>(operation: () => Promise<T>): Promise<T> {
    try {
      return await operation();
    } catch (error) {
      if (error instanceof V2ApiError) throw error;
      throw unavailable();
    }
  }

  const service: FeedbackService = {
    async uploadImage({ principal, idempotencyKey, readBytes }) {
      assertEnabled();
      if (input.media === null) throw unavailable();
      const media = input.media;
      const bytes = await readBytes();
      const uploaded = await media.upload({
        principal,
        kind: "feedback_image",
        idempotencyKey,
        bytes,
      });
      return Object.freeze({
        mediaId: uploaded.mediaId,
        url: mediaAbsoluteUrl(input.publicBaseUrl, uploaded.mediaId),
      });
    },

    async submit({ principal, idempotencyKey, body }) {
      const store = repository();
      if (typeof body !== "object" || body === null || Array.isArray(body)) {
        throw V2ApiError.invalidRequest();
      }
      const record = body as Record<string, unknown>;
      const category = record["category"];
      if (!isFeedbackCategory(category)) throw V2ApiError.invalidRequest();
      const checked = checkFeedbackBody(record["body"]);
      if (!checked.ok) throw validation(checked.reasonCode, "body");
      const rawMediaIds = record["mediaIds"] ?? [];
      if (!Array.isArray(rawMediaIds)) throw V2ApiError.invalidRequest();
      if (rawMediaIds.length > feedbackLimits.imagesMax) {
        throw validation(feedbackReasonCodes.tooManyImages, "mediaIds");
      }
      const mediaIds: string[] = [];
      for (const value of rawMediaIds) {
        if (!isFeedbackUuid(value)) {
          throw validation(feedbackReasonCodes.mediaNotOwned, "mediaIds");
        }
        if (mediaIds.includes(value)) {
          throw validation(feedbackReasonCodes.mediaDuplicate, "mediaIds");
        }
        mediaIds.push(value);
      }
      const context = normalizeFeedbackContext(record["context"]);
      const at = now();
      const created = await guarded(() =>
        store.create({
          id: createUuid(),
          accountId: principal.userId,
          category,
          body: checked.body,
          context,
          mediaIds,
          idempotency: {
            key: idempotencyKey,
            requestSha256: feedbackCreateDigest({
              category,
              body: checked.body,
              mediaIds,
              context,
            }),
          },
          now: at,
          dailyMax: feedbackLimits.dailyMax,
          windowMs: feedbackLimits.dailyWindowMs,
          mediaFreshSince: new Date(at.getTime() - feedbackLimits.mediaFreshMs),
        }),
      );
      if (created.status === "conflict") {
        throw V2ApiError.idempotencyConflict();
      }
      if (created.status === "rate_limited") {
        throw V2ApiError.fromCode("RATE_LIMITED", {
          reasonCode: feedbackReasonCodes.dailyLimit,
          limit: feedbackLimits.dailyMax,
        });
      }
      if (created.status === "media_rejected") {
        throw validation(created.reasonCode, "mediaIds");
      }
      return Object.freeze({
        replayed: created.status === "replayed",
        resource: Object.freeze({
          feedback: Object.freeze({
            id: created.record.id,
            status: created.record.status,
            createdAt: created.record.createdAt,
          }),
        }),
      });
    },

    async listMine({ principal, cursor }) {
      const store = repository();
      if (input.cursorCodec === null) throw unavailable();
      const codec = input.cursorCodec;
      let before: FeedbackPageKey | null = null;
      if (cursor !== undefined) {
        if (typeof cursor !== "string") throw V2ApiError.invalidRequest();
        let continuation;
        try {
          continuation = codec.decode({
            ownerId: principal.userId,
            route: cursorRoute,
            filter: cursorFilter,
            cursor,
          });
        } catch (error) {
          if (error instanceof InvalidV2CursorError) {
            throw V2ApiError.invalidRequest();
          }
          throw error;
        }
        const createdAt = continuation["createdAt"];
        const id = continuation["id"];
        if (
          typeof createdAt !== "string" ||
          Number.isNaN(Date.parse(createdAt)) ||
          !isFeedbackUuid(id)
        ) {
          throw V2ApiError.invalidRequest();
        }
        before = { createdAt, id };
      }
      const pageSize = feedbackLimits.minePageSize;
      const records = await guarded(() =>
        store.listMine({
          accountId: principal.userId,
          before,
          limit: pageSize + 1,
        }),
      );
      const page = records.slice(0, pageSize);
      const last = page.at(-1);
      const nextCursor =
        records.length > pageSize && last !== undefined
          ? codec.encode({
              ownerId: principal.userId,
              route: cursorRoute,
              filter: cursorFilter,
              continuation: { createdAt: last.createdAt, id: last.id },
            })
          : null;
      return Object.freeze({
        items: page.map((item) =>
          Object.freeze({
            id: item.id,
            category: item.category,
            body: item.body,
            status: item.status,
            createdAt: item.createdAt,
            images: feedbackImageUrls(input.publicBaseUrl, item),
          }),
        ),
        nextCursor,
      });
    },
  };
  return Object.freeze(service);
}
