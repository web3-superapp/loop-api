import type { FastifyInstance, FastifyRequest } from "fastify";

import { noStoreResponseHeaders } from "../../core/http/schemas.js";
import { adminApiPrefix } from "../../features/admin/admin-contract.js";
import type { AdminPermission } from "../../features/admin/admin-roles.js";
import type { AdminSquarePostService } from "../../features/admin/admin-square-posts.js";
import type { AdminWriteContext } from "../../features/admin/admin-service.js";
import {
  squareLimits,
  squarePostKinds,
  squarePostStatuses,
  squareReasonCodes,
  squareTokenKinds,
} from "../../features/square/square-contract.js";
import {
  adminErrors,
  adminSecurity,
  auditReferenceSchema,
  guardedSessionErrors,
} from "./admin-schemas.js";
import type { AdminRouteGuard } from "./index.js";

/**
 * Decision 0143 console routes: the square timeline posts under
 * `/admin/v1/square/posts` — reads with console.read, writes (create,
 * update, publish, archive) with console.write (platform_admin), each
 * write audited in its own transaction (Decision 0140 discipline).
 */

export interface AdminSquarePostRouteDependencies {
  readonly service: AdminSquarePostService;
  readonly guard: (permission: AdminPermission) => AdminRouteGuard;
  readonly context: (request: FastifyRequest) => AdminWriteContext;
}

const base = `${adminApiPrefix}/square/posts`;
const uuidSchema = { type: "string", format: "uuid" } as const;
const dateTimeSchema = { type: "string", format: "date-time" } as const;
const uuidV4Source =
  "^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$";

const emptyQuerySchema = {
  type: "object",
  additionalProperties: false,
  properties: {},
} as const;

const optionalIdempotencyHeadersSchema = {
  type: "object",
  properties: {
    "idempotency-key": {
      type: "string",
      pattern: uuidV4Source,
      description:
        "Optional lower-case UUIDv4. Create: the same key with the same body replays the first result (200 `replayed: true`); another body is 409 ADMIN_CONFLICT / ADMIN_IDEMPOTENCY_CONFLICT. Update / publish / archive accept it and do not deduplicate (a repeated publish / archive is 409 SQUARE_POST_STATUS_CONFLICT).",
    },
  },
} as const;

const tokenRefSchema = {
  type: "object",
  additionalProperties: false,
  required: ["kind", "id"],
  properties: {
    kind: { type: "string", enum: [...squareTokenKinds] },
    id: uuidSchema,
  },
} as const;

export const adminSquarePostSchema = {
  type: "object",
  additionalProperties: false,
  required: [
    "postId",
    "kind",
    "status",
    "text",
    "tokenRef",
    "pinned",
    "author",
    "event",
    "sourceEventId",
    "likeCount",
    "publishedAt",
    "createdAt",
    "updatedAt",
  ],
  properties: {
    postId: uuidSchema,
    kind: { type: "string", enum: [...squarePostKinds] },
    status: { type: "string", enum: [...squarePostStatuses] },
    text: {
      anyOf: [
        { type: "string", minLength: 1, maxLength: squareLimits.textMax },
        { type: "null" },
      ],
    },
    tokenRef: { anyOf: [tokenRefSchema, { type: "null" }] },
    pinned: { type: "boolean" },
    author: {
      anyOf: [
        {
          type: "object",
          additionalProperties: false,
          required: ["publicProfileId", "loopId", "alias"],
          properties: {
            publicProfileId: uuidSchema,
            loopId: { type: "string" },
            alias: { anyOf: [{ type: "string" }, { type: "null" }] },
          },
        },
        { type: "null" },
      ],
      description: "null for kind system (and for an author without profile).",
    },
    event: {
      anyOf: [
        {
          type: "object",
          additionalProperties: {
            anyOf: [{ type: "string" }, { type: "null" }],
          },
        },
        { type: "null" },
      ],
    },
    sourceEventId: { anyOf: [{ type: "string" }, { type: "null" }] },
    likeCount: { type: "integer", minimum: 0 },
    publishedAt: { anyOf: [dateTimeSchema, { type: "null" }] },
    createdAt: dateTimeSchema,
    updatedAt: dateTimeSchema,
  },
} as const;

const listResourceSchema = {
  type: "object",
  headers: noStoreResponseHeaders(),
  additionalProperties: false,
  required: ["items", "generatedAt"],
  properties: {
    items: {
      type: "array",
      maxItems: squareLimits.adminListMax,
      items: adminSquarePostSchema,
    },
    generatedAt: dateTimeSchema,
  },
} as const;

const readResourceSchema = {
  type: "object",
  headers: noStoreResponseHeaders(),
  additionalProperties: false,
  required: ["post"],
  properties: { post: adminSquarePostSchema },
} as const;

const writeResourceSchema = {
  type: "object",
  headers: noStoreResponseHeaders(),
  additionalProperties: false,
  required: ["post", "audit"],
  properties: { post: adminSquarePostSchema, audit: auditReferenceSchema },
} as const;

const createResourceSchema = {
  ...writeResourceSchema,
  required: [...writeResourceSchema.required, "replayed"],
  properties: {
    ...writeResourceSchema.properties,
    replayed: { type: "boolean" },
  },
} as const;

/** JSON types only: every length / format rule answers 422 from the service. */
const fieldProperties = {
  text: {
    type: "string",
    description: `1–${String(squareLimits.textMax)} characters after trim.`,
  },
  tokenRef: {
    // null first: the coercing validator would turn null into "".
    anyOf: [{ type: "null" }, { type: "object" }],
    description:
      "{kind: meme | launch2, id}; null clears. Unknown → 422 SQUARE_TOKEN_REF_INVALID.",
  },
  pinned: {
    type: "boolean",
    description: `Pinned published posts lead the first feed page (newest ${String(squareLimits.pinnedMax)}).`,
  },
} as const;

const createBodySchema = {
  type: "object",
  additionalProperties: false,
  required: ["text"],
  properties: fieldProperties,
} as const;

const updateBodySchema = {
  type: "object",
  additionalProperties: false,
  minProperties: 1,
  properties: fieldProperties,
} as const;

const postParamsSchema = {
  type: "object",
  additionalProperties: false,
  required: ["postId"],
  properties: { postId: { type: "string", maxLength: 64 } },
} as const;

const validationNote = `422 VALIDATION_FAILED with detailsSafe.reasonCode + field: ${squareReasonCodes.textEmpty} / ${squareReasonCodes.textTooLong} / ${squareReasonCodes.textInvalid} (text), ${squareReasonCodes.tokenRefInvalid} (tokenRef).`;

const writeErrors = adminErrors(
  ...guardedSessionErrors,
  "INVALID_REQUEST",
  "NOT_FOUND",
  "ADMIN_CONFLICT",
  "VALIDATION_FAILED",
  "CAPABILITY_UNAVAILABLE",
);

function idempotencyKeyOf(request: FastifyRequest): string | null {
  const raw = request.headers["idempotency-key"];
  return typeof raw === "string" ? raw : null;
}

export function registerAdminSquarePostRoutes(
  app: FastifyInstance,
  dependencies: AdminSquarePostRouteDependencies,
): void {
  const { service, guard, context } = dependencies;

  app.get(
    base,
    {
      schema: {
        operationId: "listAdminSquarePosts",
        summary: "List square posts",
        description: `Decision 0143: every post (or one status / kind), newest created first, ≤ ${String(squareLimits.adminListMax)}. Without the database: 503 CAPABILITY_UNAVAILABLE (SQUARE_REPOSITORY_UNAVAILABLE). console.read.`,
        tags: ["admin-square"],
        security: adminSecurity,
        querystring: {
          type: "object",
          additionalProperties: false,
          properties: {
            status: { type: "string", enum: [...squarePostStatuses] },
            kind: { type: "string", enum: [...squarePostKinds] },
          },
        },
        response: {
          200: listResourceSchema,
          ...adminErrors(
            ...guardedSessionErrors,
            "INVALID_REQUEST",
            "CAPABILITY_UNAVAILABLE",
          ),
        },
      },
      ...guard("console.read"),
    },
    async (request, reply) => {
      const resource = await service.list(
        request.query as Record<string, unknown>,
      );
      reply.header("cache-control", "no-store");
      return reply.code(200).send(resource);
    },
  );

  app.get(
    `${base}/:postId`,
    {
      schema: {
        operationId: "getAdminSquarePost",
        summary: "Get one square post",
        description:
          "Decision 0143: one post in any status and kind. Unknown: 404 NOT_FOUND (SQUARE_POST_NOT_FOUND). console.read.",
        tags: ["admin-square"],
        security: adminSecurity,
        params: postParamsSchema,
        querystring: emptyQuerySchema,
        response: {
          200: readResourceSchema,
          ...adminErrors(
            ...guardedSessionErrors,
            "NOT_FOUND",
            "CAPABILITY_UNAVAILABLE",
          ),
        },
      },
      ...guard("console.read"),
    },
    async (request, reply) => {
      const { postId } = request.params as { readonly postId: string };
      const resource = await service.get(postId);
      reply.header("cache-control", "no-store");
      return reply.code(200).send(resource);
    },
  );

  app.post(
    base,
    {
      schema: {
        operationId: "createAdminSquarePost",
        summary: "Create an official square post (draft)",
        description: `Decision 0143: creates a kind system draft (no author; pinned defaults to false). Writes admin_audit_log \`square.post.create\` (target square_post) in the same transaction. 201; an Idempotency-Key replay is 200 with \`replayed: true\` and the first create's audit reference. ${validationNote} console.write (platform_admin).`,
        tags: ["admin-square"],
        security: adminSecurity,
        headers: optionalIdempotencyHeadersSchema,
        querystring: emptyQuerySchema,
        body: createBodySchema,
        response: {
          200: createResourceSchema,
          201: createResourceSchema,
          ...writeErrors,
        },
      },
      ...guard("console.write"),
    },
    async (request, reply) => {
      const resource = await service.create(
        context(request),
        request.body,
        idempotencyKeyOf(request),
      );
      reply.header("cache-control", "no-store");
      return reply.code(resource.replayed ? 200 : 201).send(resource);
    },
  );

  app.patch(
    `${base}/:postId`,
    {
      schema: {
        operationId: "updateAdminSquarePost",
        summary: "Update an official square post",
        description: `Decision 0143: replaces the given fields (any non-empty subset of text, tokenRef, pinned) of a draft or published kind system post; a published post changes on the App at its next read. Archived: 409 ADMIN_CONFLICT (SQUARE_POST_STATUS_CONFLICT, detailsSafe.status). Any other kind: 409 ADMIN_CONFLICT (SQUARE_POST_KIND_CONFLICT; the console can only archive those). Unknown: 404 NOT_FOUND. Writes admin_audit_log \`square.post.update\` (before / after snapshots). ${validationNote} console.write (platform_admin).`,
        tags: ["admin-square"],
        security: adminSecurity,
        headers: optionalIdempotencyHeadersSchema,
        params: postParamsSchema,
        querystring: emptyQuerySchema,
        body: updateBodySchema,
        response: { 200: writeResourceSchema, ...writeErrors },
      },
      ...guard("console.write"),
    },
    async (request, reply) => {
      const { postId } = request.params as { readonly postId: string };
      const resource = await service.update(
        context(request),
        postId,
        request.body,
      );
      reply.header("cache-control", "no-store");
      return reply.code(200).send(resource);
    },
  );

  for (const [action, operationId, summary, description] of [
    [
      "publish",
      "publishAdminSquarePost",
      "Publish an official square post",
      "Decision 0143: draft → published (kind system only; publishedAt = now, the timeline key). Already published or archived (archived is final): 409 ADMIN_CONFLICT (SQUARE_POST_STATUS_CONFLICT, detailsSafe.status). Any other kind: 409 ADMIN_CONFLICT (SQUARE_POST_KIND_CONFLICT). Writes admin_audit_log `square.post.publish`.",
    ],
    [
      "archive",
      "archiveAdminSquarePost",
      "Archive a square post",
      "Decision 0143: draft or published → archived (final; gone from the App at its next read). Works on every kind (moderation of user and event posts). Already archived: 409 ADMIN_CONFLICT (SQUARE_POST_STATUS_CONFLICT). Writes admin_audit_log `square.post.archive`.",
    ],
  ] as const) {
    app.post(
      `${base}/:postId/${action}`,
      {
        schema: {
          operationId,
          summary,
          description: `${description} Unknown: 404 NOT_FOUND (SQUARE_POST_NOT_FOUND). Any request body is ignored. console.write (platform_admin).`,
          tags: ["admin-square"],
          security: adminSecurity,
          headers: optionalIdempotencyHeadersSchema,
          params: postParamsSchema,
          querystring: emptyQuerySchema,
          response: { 200: writeResourceSchema, ...writeErrors },
        },
        ...guard("console.write"),
      },
      async (request, reply) => {
        const { postId } = request.params as { readonly postId: string };
        const resource =
          action === "publish"
            ? await service.publish(context(request), postId)
            : await service.archive(context(request), postId);
        reply.header("cache-control", "no-store");
        return reply.code(200).send(resource);
      },
    );
  }
}
