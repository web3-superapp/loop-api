import { randomUUID } from "node:crypto";

import { sha256Hex } from "../media/media-processor.js";
import {
  checkSquarePostText,
  isSquarePostKind,
  isSquarePostStatus,
  isSquareUuid,
  parseSquareTokenRef,
  squareLimits,
  squareReasonCodes,
  type SquareAdminAction,
  type SquareAdminDecision,
  type SquareAuditInput,
  type SquareAuditRef,
  type SquarePostRecord,
  type SquareRepository,
  type SquareSystemFields,
  type SquareTokenRef,
} from "../square/square-contract.js";
import { AdminApiError } from "./admin-contract.js";
import type { AdminWriteContext } from "./admin-service.js";

/**
 * Decision 0143 §5: the console side of the square timeline — list / get
 * (console.read) and create / update / publish / archive (console.write),
 * the Decision 0140 discipline: field rules here (422 VALIDATION_FAILED +
 * `detailsSafe.reasonCode` + `field`), a refused transition 409
 * ADMIN_CONFLICT with `detailsSafe.reasonCode`, nothing written; each
 * write and its audit row in one transaction.
 *
 * The console writes `system` posts (draft → published → archived, may be
 * pinned). Any other kind can only be archived here (moderation).
 */

export interface AdminSquarePostResource {
  readonly postId: string;
  readonly kind: string;
  readonly status: string;
  readonly text: string | null;
  readonly tokenRef: SquareTokenRef | null;
  readonly pinned: boolean;
  readonly author: {
    readonly publicProfileId: string;
    readonly loopId: string;
    readonly alias: string | null;
  } | null;
  readonly event: Readonly<Record<string, string | null>> | null;
  readonly sourceEventId: string | null;
  readonly likeCount: number;
  readonly publishedAt: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface AdminSquarePostWriteResource {
  readonly post: AdminSquarePostResource;
  readonly audit: SquareAuditRef;
}

export interface AdminSquarePostService {
  list(query: Record<string, unknown>): Promise<{
    readonly items: readonly AdminSquarePostResource[];
    readonly generatedAt: string;
  }>;
  get(postId: string): Promise<{ readonly post: AdminSquarePostResource }>;
  create(
    context: AdminWriteContext,
    body: unknown,
    idempotencyKey: string | null,
  ): Promise<AdminSquarePostWriteResource & { readonly replayed: boolean }>;
  update(
    context: AdminWriteContext,
    postId: string,
    body: unknown,
  ): Promise<AdminSquarePostWriteResource>;
  publish(
    context: AdminWriteContext,
    postId: string,
  ): Promise<AdminSquarePostWriteResource>;
  archive(
    context: AdminWriteContext,
    postId: string,
  ): Promise<AdminSquarePostWriteResource>;
}

type Body = Record<string, unknown>;

const editableKeys = Object.freeze(["text", "tokenRef", "pinned"] as const);

function invalid(reasonCode: string, field: string): AdminApiError {
  return new AdminApiError("VALIDATION_FAILED", { reasonCode, field });
}

function asBody(body: unknown): Body {
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    throw new AdminApiError("INVALID_REQUEST");
  }
  return body as Body;
}

type Patch = {
  -readonly [K in keyof SquareSystemFields]?: SquareSystemFields[K];
};
export type AdminSquarePatch = Partial<SquareSystemFields>;

function parsePatch(body: Body, mode: "create" | "update"): Patch {
  for (const key of Object.keys(body)) {
    if (!(editableKeys as readonly string[]).includes(key)) {
      throw new AdminApiError("INVALID_REQUEST");
    }
  }
  const has = (key: string): boolean =>
    Object.prototype.hasOwnProperty.call(body, key) && body[key] !== undefined;
  const patch: Patch = {};
  if (has("text") || mode === "create") {
    const checked = checkSquarePostText(body["text"]);
    if (!checked.ok) throw invalid(checked.reasonCode, "text");
    patch.text = checked.text;
  }
  if (has("tokenRef")) {
    const raw = body["tokenRef"];
    if (raw === null) {
      patch.tokenRef = null;
    } else {
      const ref = parseSquareTokenRef(raw);
      if (ref === null) {
        throw invalid(squareReasonCodes.tokenRefInvalid, "tokenRef");
      }
      patch.tokenRef = ref;
    }
  }
  if (has("pinned")) {
    if (typeof body["pinned"] !== "boolean") {
      throw new AdminApiError("INVALID_REQUEST");
    }
    patch.pinned = body["pinned"];
  }
  return patch;
}

function fieldsOf(record: SquarePostRecord): SquareSystemFields {
  return Object.freeze({
    text: record.text ?? "",
    tokenRef: record.tokenRef,
    pinned: record.pinned,
  });
}

/** Pure transition rules (unit-tested without a database). */
export function decideSquareAdminTransition(
  action: SquareAdminAction,
  current: SquarePostRecord,
  patch: AdminSquarePatch = {},
): SquareAdminDecision {
  const statusConflict: SquareAdminDecision = {
    kind: "refuse",
    reasonCode: squareReasonCodes.statusConflict,
  };
  if (action === "archive") {
    return current.status === "archived"
      ? statusConflict
      : { kind: "write", fields: null, status: "archived" };
  }
  if (current.kind !== "system") {
    return { kind: "refuse", reasonCode: squareReasonCodes.kindConflict };
  }
  if (action === "publish") {
    return current.status === "draft"
      ? { kind: "write", fields: null, status: "published" }
      : statusConflict;
  }
  if (current.status === "archived") return statusConflict;
  return {
    kind: "write",
    fields: Object.freeze({ ...fieldsOf(current), ...patch }),
    status: current.status,
  };
}

export function createAdminSquarePostService(input: {
  readonly repository: SquareRepository | null;
  readonly now?: () => Date;
  readonly createUuid?: () => string;
}): AdminSquarePostService {
  const now = input.now ?? ((): Date => new Date());
  const createUuid = input.createUuid ?? randomUUID;
  const unavailable = (): AdminApiError =>
    new AdminApiError("CAPABILITY_UNAVAILABLE", {
      reasonCode: squareReasonCodes.repositoryUnavailable,
    });
  const notFound = (): AdminApiError =>
    new AdminApiError("NOT_FOUND", { reasonCode: squareReasonCodes.notFound });

  function repository(): SquareRepository {
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

  function resource(
    record: SquarePostRecord & { readonly likeCount: number },
  ): AdminSquarePostResource {
    return Object.freeze({
      postId: record.postId,
      kind: record.kind,
      status: record.status,
      text: record.text,
      tokenRef:
        record.tokenRef === null ? null : Object.freeze({ ...record.tokenRef }),
      pinned: record.pinned,
      author:
        record.author === null
          ? null
          : Object.freeze({
              publicProfileId: record.author.publicProfileId,
              loopId: record.author.loopId,
              alias: record.author.alias,
            }),
      event: record.event === null ? null : Object.freeze({ ...record.event }),
      sourceEventId: record.sourceEventId,
      likeCount: record.likeCount,
      publishedAt: record.publishedAt,
      createdAt: record.createdAt,
      updatedAt: record.updatedAt,
    });
  }

  function auditOf(context: AdminWriteContext): SquareAuditInput {
    return {
      actor: context.session.actor,
      actorAccountId: context.session.accountId,
      requestId: context.requestId,
    };
  }

  async function assertTokenRef(
    store: SquareRepository,
    ref: SquareTokenRef | null | undefined,
  ): Promise<void> {
    if (ref === null || ref === undefined) return;
    const exists = await guarded(() => store.tokenRefExists(ref));
    if (!exists) throw invalid(squareReasonCodes.tokenRefInvalid, "tokenRef");
  }

  async function reread(
    store: SquareRepository,
    postId: string,
  ): Promise<AdminSquarePostResource> {
    const record = await guarded(() => store.adminGet(postId));
    if (record === null) throw unavailable();
    return resource(record);
  }

  async function transition(
    context: AdminWriteContext,
    postId: string,
    action: SquareAdminAction,
    patch: Patch = {},
  ): Promise<AdminSquarePostWriteResource> {
    const store = repository();
    if (!isSquareUuid(postId)) throw notFound();
    const result = await guarded(() =>
      store.adminTransition({
        postId,
        action,
        now: now(),
        audit: auditOf(context),
        decide: (current) =>
          decideSquareAdminTransition(action, current, patch),
      }),
    );
    if (result.status === "not_found") throw notFound();
    if (result.status === "refused") {
      throw new AdminApiError("ADMIN_CONFLICT", {
        reasonCode: result.reasonCode,
        status: result.current.status,
        kind: result.current.kind,
      });
    }
    return Object.freeze({
      post: await reread(store, postId),
      audit: Object.freeze({ ...result.audit }),
    });
  }

  return Object.freeze({
    async list(query: Record<string, unknown>) {
      const store = repository();
      const status = query["status"];
      const kind = query["kind"];
      if (status !== undefined && !isSquarePostStatus(status)) {
        throw new AdminApiError("INVALID_REQUEST");
      }
      if (kind !== undefined && !isSquarePostKind(kind)) {
        throw new AdminApiError("INVALID_REQUEST");
      }
      const records = await guarded(() =>
        store.adminList({
          status: status ?? null,
          kind: kind ?? null,
          limit: squareLimits.adminListMax,
        }),
      );
      return Object.freeze({
        items: records.map(resource),
        generatedAt: now().toISOString(),
      });
    },

    async get(postId: string) {
      const store = repository();
      if (!isSquareUuid(postId)) throw notFound();
      const record = await guarded(() => store.adminGet(postId));
      if (record === null) throw notFound();
      return Object.freeze({ post: resource(record) });
    },

    async create(
      context: AdminWriteContext,
      body: unknown,
      idempotencyKey: string | null,
    ) {
      const store = repository();
      const patch = parsePatch(asBody(body), "create");
      const fields: SquareSystemFields = Object.freeze({
        text: patch.text as string,
        tokenRef: patch.tokenRef ?? null,
        pinned: patch.pinned ?? false,
      });
      await assertTokenRef(store, fields.tokenRef);
      const postId = createUuid();
      const created = await guarded(() =>
        store.adminCreate({
          postId,
          fields,
          now: now(),
          audit: auditOf(context),
          idempotency:
            idempotencyKey === null
              ? null
              : {
                  key: idempotencyKey,
                  requestSha256: sha256Hex(
                    Buffer.from(
                      JSON.stringify({ actor: context.session.actor, fields }),
                    ),
                  ),
                },
        }),
      );
      if (created.status === "conflict") {
        throw new AdminApiError("ADMIN_CONFLICT", {
          reasonCode: squareReasonCodes.idempotencyConflict,
        });
      }
      return Object.freeze({
        post: await reread(store, created.postId),
        audit: Object.freeze({ ...created.audit }),
        replayed: created.status === "replayed",
      });
    },

    async update(context: AdminWriteContext, postId: string, body: unknown) {
      const store = repository();
      const raw = asBody(body);
      if (Object.keys(raw).length === 0) {
        throw new AdminApiError("INVALID_REQUEST");
      }
      if (!isSquareUuid(postId)) throw notFound();
      const patch = parsePatch(raw, "update");
      await assertTokenRef(store, patch.tokenRef);
      return transition(context, postId, "update", patch);
    },

    publish(context: AdminWriteContext, postId: string) {
      return transition(context, postId, "publish");
    },

    archive(context: AdminWriteContext, postId: string) {
      return transition(context, postId, "archive");
    },
  });
}
