import { createHash, randomUUID } from "node:crypto";

import type { AuthenticatedLoopPrincipal } from "../../core/http/authentication.js";
import {
  InvalidV2CursorError,
  type V2CursorCodec,
} from "../../core/http/v2-cursor.js";
import { V2ApiError } from "../../core/http/v2-error.js";
import { v2ContractVersion } from "../meta/product-policy.js";
import {
  checkSquarePostText,
  isSquareUuid,
  mergeSquareFirstPage,
  parseSquareTokenRef,
  projectSquareToken,
  squareFeedScopes,
  squareLimits,
  squareReasonCodes,
  type SquareFeedCursor,
  type SquareFeedRecord,
  type SquareFeedScope,
  type SquareRepository,
  type SquareTokenRef,
} from "./square-contract.js";

/**
 * Decision 0143: the App side of the square timeline — `GET
 * /v2/square/feed`, `POST /v2/square/posts`, `DELETE /v2/square/posts/{id}`
 * and `PUT|DELETE /v2/square/posts/{id}/like`. Without the repository (or
 * when it fails) every route is 503 CAPABILITY_UNAVAILABLE /
 * SQUARE_REPOSITORY_UNAVAILABLE, never an empty list.
 */

export interface SquareService {
  readonly available: boolean;
  getFeed(input: {
    readonly principal: AuthenticatedLoopPrincipal;
    readonly scope: unknown;
    readonly cursor: unknown;
    readonly limit: unknown;
  }): Promise<Record<string, unknown>>;
  createPost(input: {
    readonly principal: AuthenticatedLoopPrincipal;
    readonly idempotencyKey: string;
    readonly body: unknown;
  }): Promise<{
    readonly replayed: boolean;
    readonly resource: Record<string, unknown>;
  }>;
  deletePost(input: {
    readonly principal: AuthenticatedLoopPrincipal;
    readonly postId: string;
  }): Promise<void>;
  setLike(input: {
    readonly principal: AuthenticatedLoopPrincipal;
    readonly postId: string;
    readonly liked: boolean;
  }): Promise<Record<string, unknown>>;
}

const cursorRoute = "v2SquareFeed";

function cursorFilter(scope: SquareFeedScope): string {
  return `scope=${scope}`;
}

/** The wire item of one post (feed, create). */
export function projectSquareFeedItem(
  record: SquareFeedRecord,
  publicBaseUrl: string,
): Record<string, unknown> {
  return Object.freeze({
    postId: record.postId,
    kind: record.kind,
    author:
      record.author === null
        ? null
        : Object.freeze({
            publicProfileId: record.author.publicProfileId,
            loopId: record.author.loopId,
            alias: record.author.alias,
            avatarRef: record.author.avatarRef,
          }),
    text: record.text,
    token:
      record.token === null
        ? null
        : projectSquareToken(record.token, publicBaseUrl),
    event: record.event === null ? null : Object.freeze({ ...record.event }),
    likeCount: record.likeCount,
    likedByViewer: record.likedByViewer,
    pinned: record.pinned,
    createdAt: record.publishedAt ?? record.createdAt,
  });
}

function validation(reasonCode: string, field: string): V2ApiError {
  return V2ApiError.fromCode("VALIDATION_FAILED", { reasonCode, field });
}

export function squareCreateDigest(input: {
  readonly text: string;
  readonly tokenRef: SquareTokenRef | null;
}): string {
  return createHash("sha256")
    .update(
      JSON.stringify([
        "loop:v2:square:post_create:v1",
        v2ContractVersion,
        input.text,
        input.tokenRef?.kind ?? null,
        input.tokenRef?.id ?? null,
      ]),
    )
    .digest("hex");
}

export function createSquareService(input: {
  readonly repository: SquareRepository | null;
  readonly cursorCodec: V2CursorCodec | null;
  readonly publicBaseUrl: string;
  readonly now?: () => Date;
  readonly createUuid?: () => string;
}): SquareService {
  const now = input.now ?? ((): Date => new Date());
  const createUuid = input.createUuid ?? randomUUID;
  const unavailable = (): V2ApiError =>
    V2ApiError.fromCode("CAPABILITY_UNAVAILABLE", {
      reasonCode: squareReasonCodes.repositoryUnavailable,
    });

  function repository(): SquareRepository {
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

  function codec(): V2CursorCodec {
    if (input.cursorCodec === null) throw unavailable();
    return input.cursorCodec;
  }

  const service: SquareService = {
    available: input.repository !== null && input.cursorCodec !== null,

    async getFeed({ principal, scope: rawScope, cursor, limit }) {
      const store = repository();
      const cursors = codec();
      if (cursor !== undefined && limit !== undefined) {
        throw V2ApiError.invalidRequest();
      }
      let scope: SquareFeedScope = "global";
      if (rawScope !== undefined) {
        if (
          typeof rawScope !== "string" ||
          !(squareFeedScopes as readonly string[]).includes(rawScope)
        ) {
          throw V2ApiError.invalidRequest();
        }
        scope = rawScope as SquareFeedScope;
      }
      let pageSize: number = squareLimits.feedDefault;
      let before: SquareFeedCursor | null = null;
      if (cursor !== undefined) {
        if (typeof cursor !== "string") throw V2ApiError.invalidRequest();
        let continuation;
        try {
          continuation = cursors.decode({
            ownerId: principal.userId,
            route: cursorRoute,
            filter: cursorFilter(scope),
            cursor,
          });
        } catch (error) {
          if (error instanceof InvalidV2CursorError) {
            throw V2ApiError.invalidRequest();
          }
          throw error;
        }
        const publishedAt = continuation["publishedAt"];
        const postId = continuation["postId"];
        const size = continuation["limit"];
        if (
          typeof publishedAt !== "string" ||
          !isSquareUuid(postId) ||
          typeof size !== "number" ||
          !Number.isInteger(size) ||
          size < 1 ||
          size > squareLimits.feedMax
        ) {
          throw V2ApiError.invalidRequest();
        }
        before = { publishedAt, postId };
        pageSize = size;
      } else if (limit !== undefined) {
        if (
          typeof limit !== "number" ||
          !Number.isInteger(limit) ||
          limit < 1 ||
          limit > squareLimits.feedMax
        ) {
          throw V2ApiError.invalidRequest();
        }
        pageSize = limit;
      }
      const at = now();
      const [pinned, timeline] = await guarded(() =>
        Promise.all([
          before === null
            ? store.listPinned({
                viewerUserId: principal.userId,
                limit: squareLimits.pinnedMax,
                now: at,
              })
            : Promise.resolve([] as readonly SquareFeedRecord[]),
          store.listTimeline({
            viewerUserId: principal.userId,
            scope,
            before,
            limit: pageSize + 1,
            now: at,
          }),
        ]),
      );
      const page = timeline.slice(0, pageSize);
      const last = page.at(-1);
      const nextCursor =
        timeline.length > pageSize && last !== undefined
          ? cursors.encode({
              ownerId: principal.userId,
              route: cursorRoute,
              filter: cursorFilter(scope),
              continuation: {
                publishedAt: last.publishedAt ?? last.createdAt,
                postId: last.postId,
                limit: pageSize,
              },
            })
          : null;
      const items = before === null ? mergeSquareFirstPage(pinned, page) : page;
      return Object.freeze({
        scope,
        items: items.map((record) =>
          projectSquareFeedItem(record, input.publicBaseUrl),
        ),
        nextCursor,
        observedAt: at.toISOString(),
        contractVersion: v2ContractVersion,
      });
    },

    async createPost({ principal, idempotencyKey, body }) {
      const store = repository();
      if (typeof body !== "object" || body === null || Array.isArray(body)) {
        throw V2ApiError.invalidRequest();
      }
      const record = body as Record<string, unknown>;
      const checked = checkSquarePostText(record["text"]);
      if (!checked.ok) throw validation(checked.reasonCode, "text");
      let tokenRef: SquareTokenRef | null = null;
      if (record["tokenRef"] !== undefined && record["tokenRef"] !== null) {
        tokenRef = parseSquareTokenRef(record["tokenRef"]);
        if (tokenRef === null) {
          throw validation(squareReasonCodes.tokenRefInvalid, "tokenRef");
        }
        const ref = tokenRef;
        const exists = await guarded(() => store.tokenRefExists(ref));
        if (!exists) {
          throw validation(squareReasonCodes.tokenRefInvalid, "tokenRef");
        }
      }
      const at = now();
      const created = await guarded(() =>
        store.createOpinion({
          postId: createUuid(),
          authorUserId: principal.userId,
          text: checked.text,
          tokenRef,
          idempotency: {
            key: idempotencyKey,
            requestSha256: squareCreateDigest({ text: checked.text, tokenRef }),
          },
          now: at,
          postsPerMinute: squareLimits.postsPerMinute,
          windowMs: squareLimits.rateWindowMs,
        }),
      );
      if (created.status === "conflict") {
        throw V2ApiError.idempotencyConflict();
      }
      if (created.status === "profile_required") {
        throw V2ApiError.fromCode("PROFILE_ACTIVATION_REQUIRED");
      }
      if (created.status === "rate_limited") {
        throw V2ApiError.fromCode("RATE_LIMITED", {
          reasonCode: squareReasonCodes.rateLimited,
        });
      }
      if (!("postId" in created)) throw unavailable();
      const createdPostId = created.postId;
      const post = await guarded(() =>
        store.getFeedPost({
          viewerUserId: principal.userId,
          postId: createdPostId,
          now: at,
        }),
      );
      // A replay of a post its author has since deleted.
      if (post === null) throw V2ApiError.idempotencyConflict();
      return Object.freeze({
        replayed: created.status === "replayed",
        resource: Object.freeze({
          post: projectSquareFeedItem(post, input.publicBaseUrl),
          contractVersion: v2ContractVersion,
        }),
      });
    },

    async deletePost({ principal, postId }) {
      const store = repository();
      if (!isSquareUuid(postId)) throw V2ApiError.notFound();
      const archived = await guarded(() =>
        store.archiveOwnPost({
          postId,
          authorUserId: principal.userId,
          now: now(),
        }),
      );
      if (!archived) throw V2ApiError.notFound();
    },

    async setLike({ principal, postId, liked }) {
      const store = repository();
      if (!isSquareUuid(postId)) throw V2ApiError.notFound();
      const result = await guarded(() =>
        store.setLike({ postId, userId: principal.userId, liked }),
      );
      if (result === null) throw V2ApiError.notFound();
      return Object.freeze({
        postId,
        likeCount: result.likeCount,
        likedByViewer: liked,
        contractVersion: v2ContractVersion,
      });
    },
  };
  return Object.freeze(service);
}
