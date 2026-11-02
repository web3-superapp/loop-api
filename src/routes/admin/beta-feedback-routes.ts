import type { FastifyInstance, FastifyRequest } from "fastify";

import { noStoreResponseHeaders } from "../../core/http/schemas.js";
import { adminApiPrefix } from "../../features/admin/admin-contract.js";
import type { AdminFeedbackService } from "../../features/admin/admin-beta-feedback.js";
import type { AdminPermission } from "../../features/admin/admin-roles.js";
import type { AdminWriteContext } from "../../features/admin/admin-service.js";
import {
  feedbackCategories,
  feedbackContextKeys,
  feedbackLimits,
  feedbackReasonCodes,
  feedbackStatuses,
} from "../../features/feedback/feedback-contract.js";
import {
  adminErrors,
  adminSecurity,
  auditReferenceSchema,
  guardedSessionErrors,
} from "./admin-schemas.js";
import type { AdminRouteGuard } from "./index.js";

/**
 * Decision 0193 (主代理决策 0262, revised: mounted under `/admin/v1`):
 * beta feedback triage. Reads: console.read (platform_admin, auditor) or
 * launch.approve (reviewer). Update: console.write (platform_admin) or
 * launch.approve (reviewer). testnet_acceptor holds neither (403). Each
 * update writes admin_audit_log `beta_feedback.update` in its transaction.
 */

export interface AdminFeedbackRouteDependencies {
  readonly service: AdminFeedbackService;
  readonly guardAny: (
    permissions: readonly [AdminPermission, ...AdminPermission[]],
  ) => AdminRouteGuard;
  readonly context: (request: FastifyRequest) => AdminWriteContext;
}

const base = `${adminApiPrefix}/feedback`;
const uuidSchema = { type: "string", format: "uuid" } as const;
const dateTimeSchema = { type: "string", format: "date-time" } as const;
const nullableString = (maxLength: number) =>
  ({ anyOf: [{ type: "string", maxLength }, { type: "null" }] }) as const;

const emptyQuerySchema = {
  type: "object",
  additionalProperties: false,
  properties: {},
} as const;

export const adminFeedbackSchema = {
  type: "object",
  additionalProperties: false,
  required: [
    "id",
    "accountId",
    "account",
    "category",
    "body",
    "status",
    "adminNote",
    "images",
    "context",
    "createdAt",
    "updatedAt",
  ],
  properties: {
    id: uuidSchema,
    accountId: {
      ...uuidSchema,
      description: "The reporting LOOP account (opaque).",
    },
    account: {
      type: "object",
      additionalProperties: false,
      required: ["loopId", "displayName"],
      properties: {
        loopId: nullableString(64),
        displayName: {
          ...nullableString(64),
          description: "The profile alias; null without one.",
        },
      },
    },
    category: { type: "string", enum: [...feedbackCategories] },
    body: { type: "string", minLength: 1, maxLength: feedbackLimits.bodyMax },
    status: { type: "string", enum: [...feedbackStatuses] },
    adminNote: nullableString(feedbackLimits.adminNoteMax),
    images: {
      type: "array",
      maxItems: feedbackLimits.imagesMax,
      items: { type: "string", maxLength: 2048 },
      description: "Absolute public media URLs, in display order.",
    },
    context: {
      type: "object",
      additionalProperties: false,
      properties: Object.fromEntries(
        feedbackContextKeys.map((key) => [
          key,
          { type: "string", maxLength: feedbackLimits.contextValueMax },
        ]),
      ),
      description: `Only the keys the client sent among ${feedbackContextKeys.join(", ")}.`,
    },
    createdAt: dateTimeSchema,
    updatedAt: dateTimeSchema,
  },
} as const;

const listResourceSchema = {
  type: "object",
  headers: noStoreResponseHeaders(),
  additionalProperties: false,
  required: ["items", "nextCursor"],
  properties: {
    items: {
      type: "array",
      maxItems: feedbackLimits.adminPageMax,
      items: adminFeedbackSchema,
    },
    nextCursor: { anyOf: [{ type: "string" }, { type: "null" }] },
  },
} as const;

const readResourceSchema = {
  type: "object",
  headers: noStoreResponseHeaders(),
  additionalProperties: false,
  required: ["feedback"],
  properties: { feedback: adminFeedbackSchema },
} as const;

const writeResourceSchema = {
  type: "object",
  headers: noStoreResponseHeaders(),
  additionalProperties: false,
  required: ["feedback", "audit"],
  properties: { feedback: adminFeedbackSchema, audit: auditReferenceSchema },
} as const;

const paramsSchema = {
  type: "object",
  additionalProperties: false,
  required: ["feedbackId"],
  properties: { feedbackId: { type: "string", maxLength: 64 } },
} as const;

const updateBodySchema = {
  type: "object",
  additionalProperties: false,
  minProperties: 1,
  properties: {
    status: { type: "string", enum: [...feedbackStatuses] },
    adminNote: {
      // null first: the coercing validator would turn null into "".
      anyOf: [{ type: "null" }, { type: "string" }],
      description: `Trimmed, at most ${String(feedbackLimits.adminNoteMax)} code points (422 ${feedbackReasonCodes.adminNoteTooLong}); null or an empty string clears the note.`,
    },
  },
} as const;

const readPermissions = ["console.read", "launch.approve"] as const;
const writePermissions = ["console.write", "launch.approve"] as const;

export function registerAdminFeedbackRoutes(
  app: FastifyInstance,
  dependencies: AdminFeedbackRouteDependencies,
): void {
  const { service, guardAny, context } = dependencies;

  app.get(
    base,
    {
      schema: {
        operationId: "listAdminFeedback",
        summary: "List beta feedback reports",
        description: `Decision 0193: every report (or one status / category), newest first. limit 1–${String(feedbackLimits.adminPageMax)} (default ${String(feedbackLimits.adminPageDefault)}); cursor (the previous page's nextCursor, bound to status / category) and limit are mutually exclusive. Without the database: 503 CAPABILITY_UNAVAILABLE (${feedbackReasonCodes.repositoryUnavailable}). Not affected by BETA_FEEDBACK_ENABLED. console.read or launch.approve.`,
        tags: ["admin-feedback"],
        security: adminSecurity,
        querystring: {
          type: "object",
          additionalProperties: false,
          properties: {
            status: { type: "string", enum: [...feedbackStatuses] },
            category: { type: "string", enum: [...feedbackCategories] },
            cursor: { type: "string", maxLength: 1024 },
            limit: {
              type: "integer",
              minimum: 1,
              maximum: feedbackLimits.adminPageMax,
            },
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
      ...guardAny(readPermissions),
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
    `${base}/:feedbackId`,
    {
      schema: {
        operationId: "getAdminFeedback",
        summary: "Get one beta feedback report",
        description: `Decision 0193. Unknown: 404 NOT_FOUND (${feedbackReasonCodes.notFound}). console.read or launch.approve.`,
        tags: ["admin-feedback"],
        security: adminSecurity,
        params: paramsSchema,
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
      ...guardAny(readPermissions),
    },
    async (request, reply) => {
      const { feedbackId } = request.params as { readonly feedbackId: string };
      const resource = await service.get(feedbackId);
      reply.header("cache-control", "no-store");
      return reply.code(200).send(resource);
    },
  );

  app.patch(
    `${base}/:feedbackId`,
    {
      schema: {
        operationId: "updateAdminFeedback",
        summary: "Triage a beta feedback report",
        description: `Decision 0193: sets status (open | triaged | resolved | wont_fix, any to any) and / or adminNote (null clears). Writes admin_audit_log \`beta_feedback.update\` (target beta_feedback, before / after {status, adminNote}, after.changed) in the same transaction; setting the same values again still writes a row with changed: false. Unknown: 404 NOT_FOUND (${feedbackReasonCodes.notFound}). Empty body or another key: 400 INVALID_REQUEST. console.write or launch.approve.`,
        tags: ["admin-feedback"],
        security: adminSecurity,
        params: paramsSchema,
        querystring: emptyQuerySchema,
        body: updateBodySchema,
        response: {
          200: writeResourceSchema,
          ...adminErrors(
            ...guardedSessionErrors,
            "INVALID_REQUEST",
            "NOT_FOUND",
            "VALIDATION_FAILED",
            "CAPABILITY_UNAVAILABLE",
          ),
        },
      },
      ...guardAny(writePermissions),
    },
    async (request, reply) => {
      const { feedbackId } = request.params as { readonly feedbackId: string };
      const resource = await service.update(
        context(request),
        feedbackId,
        request.body,
      );
      reply.header("cache-control", "no-store");
      return reply.code(200).send(resource);
    },
  );
}
