import type { FastifyInstance } from "fastify";

import { requireAuthenticatedLoopPrincipal } from "../../core/http/authentication.js";
import { assertNoBody } from "../../core/http/request-input.js";
import {
  emptyQueryStringSchema,
  noStoreResponseHeaders,
} from "../../core/http/schemas.js";
import { v2ErrorResponseSchema } from "../../core/http/v2-error.js";
import {
  commandIdempotencyKey,
  v2CommandHeadersSchema,
  validateCommandHeaders,
} from "./notifications-schemas.js";
import { v2ContractVersion } from "../../features/meta/product-policy.js";
import { v2CommonHeadersSchema } from "../../features/session/session-contract.js";
import {
  maximumSupportBodyRawLength,
  supportReasonCodes,
  supportResponsePolicy,
  supportTicketActors,
  supportTicketCategories,
  supportTicketEventTypes,
  supportTicketListLimits,
  supportTicketStatuses,
} from "../../features/support/support-contract.js";
import {
  accountReadErrors,
  assertNoQuery,
  dateTimeSchema,
  uuidPatternSource,
  validateReadHeaders,
} from "./account-schemas.js";
import type { V2RouteDependencies } from "./index.js";

/**
 * Support tickets (D20, Decision 0037): idempotent creation, owner-scoped
 * cursor list, status advanced only by the operator script, no attachments.
 */

const safeTextPattern =
  "^(?![\\s\\S]*[\\p{Cc}\\p{Cf}\\p{Cs}\\p{Zl}\\p{Zp}])[\\s\\S]*\\S[\\s\\S]*$";

const ticketTextSchema = {
  type: "string",
  minLength: 1,
  maxLength: maximumSupportBodyRawLength,
  pattern: safeTextPattern,
} as const;

const ticketEventSchema = {
  type: "object",
  additionalProperties: false,
  required: ["eventVersion", "eventType", "actor", "note", "occurredAt"],
  properties: {
    eventVersion: { type: "integer", minimum: 0 },
    eventType: { type: "string", enum: [...supportTicketEventTypes] },
    actor: { type: "string", enum: [...supportTicketActors] },
    note: { anyOf: [ticketTextSchema, { type: "null" }] },
    occurredAt: dateTimeSchema,
  },
} as const;

const ticketSchema = {
  type: "object",
  additionalProperties: false,
  required: [
    "ticketId",
    "category",
    "body",
    "status",
    "createdAt",
    "updatedAt",
    "lastEventAt",
    "events",
  ],
  properties: {
    ticketId: { type: "string", pattern: uuidPatternSource },
    category: { type: "string", enum: [...supportTicketCategories] },
    body: ticketTextSchema,
    status: {
      type: "string",
      enum: [...supportTicketStatuses],
      description:
        "Advanced only by the Dev operator script (pnpm support:answer); the API never changes it.",
    },
    createdAt: dateTimeSchema,
    updatedAt: dateTimeSchema,
    lastEventAt: dateTimeSchema,
    events: { type: "array", minItems: 1, items: ticketEventSchema },
  },
} as const;

const attachmentsSchema = {
  type: "object",
  additionalProperties: false,
  required: ["status", "reasonCode"],
  properties: {
    status: { type: "string", const: "unavailable" },
    reasonCode: {
      type: "string",
      const: supportReasonCodes.attachmentsUnavailable,
    },
  },
} as const;

const policySchema = {
  type: "object",
  additionalProperties: false,
  required: [
    "configVersion",
    "responseWindowHours",
    "businessDaysOnly",
    "escalationChannel",
  ],
  properties: {
    configVersion: {
      type: "string",
      const: supportResponsePolicy.configVersion,
    },
    responseWindowHours: {
      type: "integer",
      const: supportResponsePolicy.responseWindowHours,
    },
    businessDaysOnly: {
      type: "boolean",
      const: supportResponsePolicy.businessDaysOnly,
    },
    escalationChannel: {
      type: "string",
      const: supportResponsePolicy.escalationChannel,
      description:
        "Emergency escalation is copy on the support page; no separate channel exists.",
    },
  },
} as const;

const ticketEnvelopeSchema = {
  type: "object",
  headers: noStoreResponseHeaders(),
  additionalProperties: false,
  required: ["ticket", "attachments", "policy", "contractVersion"],
  properties: {
    ticket: ticketSchema,
    attachments: attachmentsSchema,
    policy: policySchema,
    contractVersion: { type: "string", const: v2ContractVersion },
  },
} as const;

const ticketListResourceSchema = {
  type: "object",
  headers: noStoreResponseHeaders(),
  additionalProperties: false,
  required: ["items", "nextCursor", "attachments", "policy", "contractVersion"],
  properties: {
    items: {
      type: "array",
      maxItems: supportTicketListLimits.maximum,
      items: ticketSchema,
    },
    nextCursor: {
      anyOf: [
        { type: "string", minLength: 1, maxLength: 2_048 },
        { type: "null" },
      ],
    },
    attachments: attachmentsSchema,
    policy: policySchema,
    contractVersion: { type: "string", const: v2ContractVersion },
  },
} as const;

const createTicketRequestSchema = {
  type: "object",
  additionalProperties: false,
  required: ["category", "body"],
  properties: {
    category: { type: "string", enum: [...supportTicketCategories] },
    body: {
      ...ticketTextSchema,
      description:
        "Trimmed to 1-2000 Unicode code points; control, bidirectional-control, and invisible formatting characters are rejected (same rule as alias).",
    },
  },
} as const;

const listQuerySchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    cursor: { type: "string", minLength: 1, maxLength: 2_048 },
    limit: {
      type: "integer",
      minimum: 1,
      maximum: supportTicketListLimits.maximum,
    },
  },
} as const;

const createErrors = {
  ...accountReadErrors,
  409: v2ErrorResponseSchema([
    "ACCOUNT_BOOTSTRAP_REQUIRED",
    "IDEMPOTENCY_CONFLICT",
    "VERSION_CONFLICT",
  ]),
  422: v2ErrorResponseSchema(["VALIDATION_FAILED"]),
  429: v2ErrorResponseSchema(["RATE_LIMITED"]),
} as const;

export function registerV2SupportRoutes(
  app: FastifyInstance,
  dependencies: V2RouteDependencies,
): void {
  const { authenticateLoopBearer, supportService } = dependencies;

  app.post(
    "/v2/support/tickets",
    {
      schema: {
        operationId: "createV2SupportTicket",
        summary: "Create a support ticket",
        description:
          "Idempotency-Key bound to the owner, route, and SHA-256 of (category, body): the same key and body replays the ticket with 200, a different body is IDEMPOTENCY_CONFLICT. Bounded to 20 new tickets per owner per rolling 24 hours (RATE_LIMITED). Attachments are unavailable.",
        tags: ["support"],
        security: [{ privyBearer: [] }],
        headers: v2CommandHeadersSchema,
        querystring: emptyQueryStringSchema,
        body: createTicketRequestSchema,
        response: {
          200: ticketEnvelopeSchema,
          201: ticketEnvelopeSchema,
          ...createErrors,
        },
      },
      onRequest: validateCommandHeaders,
      preValidation: assertNoQuery,
      preHandler: authenticateLoopBearer,
    },
    async (request, reply) => {
      const result = await supportService.create({
        principal: requireAuthenticatedLoopPrincipal(request),
        idempotencyKey: commandIdempotencyKey(request),
        requestId: request.id,
        body: request.body,
      });
      reply.header("cache-control", "no-store");
      return reply.code(result.created ? 201 : 200).send(result.resource);
    },
  );

  app.get(
    "/v2/support/tickets",
    {
      schema: {
        operationId: "listV2SupportTickets",
        summary: "List the account's support tickets",
        description:
          "Newest first with the ticket's lifecycle events. cursor and limit are mutually exclusive; the cursor is bound to the owner and route and expires after 600 seconds.",
        tags: ["support"],
        security: [{ privyBearer: [] }],
        headers: v2CommonHeadersSchema,
        querystring: listQuerySchema,
        response: { 200: ticketListResourceSchema, ...accountReadErrors },
      },
      onRequest: validateReadHeaders,
      preValidation: assertNoBody,
      preHandler: authenticateLoopBearer,
    },
    async (request, reply) => {
      const query = request.query as {
        readonly cursor?: unknown;
        readonly limit?: unknown;
      };
      const resource = await supportService.list({
        principal: requireAuthenticatedLoopPrincipal(request),
        cursor: query.cursor,
        limit: query.limit,
      });
      reply.header("cache-control", "no-store");
      return reply.code(200).send(resource);
    },
  );
}
