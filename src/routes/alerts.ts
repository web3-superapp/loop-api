import type {
  FastifyInstance,
  FastifyRequest,
  onRequestHookHandler,
  preHandlerAsyncHookHandler,
} from "fastify";

import { ApiError } from "../core/http/api-error.js";
import { requireAuthenticatedLoopPrincipal } from "../core/http/authentication.js";
import {
  emptyQueryStringSchema,
  errorResponseSchema,
  noStoreResponseHeaders,
} from "../core/http/schemas.js";
import {
  AlertIdempotencyConflictError,
  AlertIdempotencyResourceDeletedError,
  AlertVersionConflictError,
} from "../database/alert-repository.js";
import {
  parseAlertIdempotencyKey,
  parsePriceAlertDefinition,
  parseReplaceNotificationPreferencesRequest,
  parseReplacePriceAlertRequest,
  type NotificationEventType,
  type PriceAlertCondition,
} from "../features/alerts/alert-contract.js";
import {
  AlertNotFoundError,
  InvalidAlertRequestError,
  type AlertService,
} from "../features/alerts/alert-service.js";

const uuidPattern =
  "^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$";
const assetKeyPattern = "^[A-Z0-9][A-Z0-9:_-]{0,63}$";
const decimalPattern = "^(?:0|[1-9][0-9]*)(?:\\.[0-9]+)?$";
const sourcePattern = "^[a-z][a-z0-9_]{0,63}$";
const sourceFactRefPattern = "^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$";
const conditions = [
  "above",
  "at_or_above",
  "below",
  "at_or_below",
] as const satisfies readonly PriceAlertCondition[];
const eventTypes = [
  "price_alert_triggered",
  "provider_activity_projected",
  "security_notice",
  "support_update",
] as const satisfies readonly NotificationEventType[];

const paginationQuerySchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    limit: { type: "integer", minimum: 1, maximum: 100, default: 50 },
    offset: { type: "integer", minimum: 0, maximum: 10_000, default: 0 },
  },
} as const;

const alertIdParamsSchema = {
  type: "object",
  additionalProperties: false,
  required: ["alert_id"],
  properties: {
    alert_id: { type: "string", pattern: uuidPattern },
  },
} as const;

const deleteQuerySchema = {
  type: "object",
  additionalProperties: false,
  required: ["expected_version"],
  properties: {
    expected_version: { type: "integer", minimum: 1 },
  },
} as const;

const createHeadersSchema = {
  type: "object",
  required: ["idempotency-key"],
  properties: {
    "idempotency-key": { type: "string", pattern: uuidPattern },
  },
} as const;

const nullableExpirySchema = {
  anyOf: [
    { type: "string", format: "date-time", maxLength: 64 },
    { type: "null" },
  ],
} as const;

const definitionProperties = {
  asset_key: {
    type: "string",
    minLength: 1,
    maxLength: 64,
    pattern: assetKeyPattern,
  },
  condition: { type: "string", enum: conditions },
  threshold_decimal: {
    type: "string",
    minLength: 1,
    maxLength: 96,
    pattern: decimalPattern,
  },
  expires_at: nullableExpirySchema,
} as const;

const createAlertBodySchema = {
  type: "object",
  additionalProperties: false,
  required: ["asset_key", "condition", "threshold_decimal", "expires_at"],
  properties: definitionProperties,
} as const;

const replaceAlertBodySchema = {
  type: "object",
  additionalProperties: false,
  required: [
    "asset_key",
    "condition",
    "threshold_decimal",
    "expires_at",
    "expected_version",
  ],
  properties: {
    ...definitionProperties,
    expected_version: { type: "integer", minimum: 1 },
  },
} as const;

const unavailableCapabilitySchema = {
  type: "object",
  additionalProperties: false,
  required: ["state"],
  properties: { state: { type: "string", const: "unavailable" } },
} as const;

const alertResourceValueSchema = {
  type: "object",
  additionalProperties: false,
  required: [
    "alert_id",
    "asset_key",
    "condition",
    "threshold_decimal",
    "expires_at",
    "state",
    "evaluation",
    "delivery",
    "version",
    "created_at",
    "updated_at",
  ],
  properties: {
    alert_id: { type: "string", pattern: uuidPattern },
    ...definitionProperties,
    state: { type: "string", const: "inactive" },
    evaluation: unavailableCapabilitySchema,
    delivery: unavailableCapabilitySchema,
    version: { type: "integer", minimum: 1 },
    created_at: { type: "string", format: "date-time" },
    updated_at: { type: "string", format: "date-time" },
  },
} as const;

const alertResourceResponseSchema = {
  ...alertResourceValueSchema,
  headers: noStoreResponseHeaders(),
} as const;

const paginatedAlertSchema = {
  type: "object",
  headers: noStoreResponseHeaders(),
  additionalProperties: false,
  required: ["items", "next_offset"],
  properties: {
    items: { type: "array", items: alertResourceValueSchema },
    next_offset: {
      anyOf: [{ type: "integer", minimum: 0 }, { type: "null" }],
    },
  },
} as const;

const historyItemSchema = {
  type: "object",
  additionalProperties: false,
  required: [
    "event_id",
    "alert_id",
    "asset_key",
    "condition",
    "threshold_decimal",
    "value_decimal",
    "source",
    "source_fact_ref",
    "observed_at",
    "created_at",
  ],
  properties: {
    event_id: { type: "string", pattern: uuidPattern },
    alert_id: { type: "string", pattern: uuidPattern },
    asset_key: definitionProperties.asset_key,
    condition: definitionProperties.condition,
    threshold_decimal: definitionProperties.threshold_decimal,
    value_decimal: definitionProperties.threshold_decimal,
    source: { type: "string", pattern: sourcePattern },
    source_fact_ref: { type: "string", pattern: sourceFactRefPattern },
    observed_at: { type: "string", format: "date-time" },
    created_at: { type: "string", format: "date-time" },
  },
} as const;

const historyResponseSchema = {
  type: "object",
  headers: noStoreResponseHeaders(),
  additionalProperties: false,
  required: ["items", "next_offset"],
  properties: {
    items: { type: "array", items: historyItemSchema },
    next_offset: {
      anyOf: [{ type: "integer", minimum: 0 }, { type: "null" }],
    },
  },
} as const;

const preferenceSchema = {
  type: "object",
  additionalProperties: false,
  required: ["event_type", "enabled"],
  properties: {
    event_type: { type: "string", enum: eventTypes },
    enabled: { type: "boolean" },
  },
} as const;

const exactPreferenceArraySchema = {
  type: "array",
  minItems: 4,
  maxItems: 4,
  items: preferenceSchema,
  allOf: eventTypes.map((eventType) => ({
    contains: {
      type: "object",
      required: ["event_type"],
      properties: { event_type: { const: eventType } },
    },
  })),
} as const;

const replacePreferencesBodySchema = {
  type: "object",
  additionalProperties: false,
  required: ["expected_version", "preferences"],
  properties: {
    expected_version: { type: "integer", minimum: 0 },
    preferences: exactPreferenceArraySchema,
  },
} as const;

const preferenceResourceSchema = {
  type: "object",
  headers: noStoreResponseHeaders(),
  additionalProperties: false,
  required: ["version", "preferences", "delivery"],
  properties: {
    version: { type: "integer", minimum: 0 },
    preferences: {
      type: "array",
      minItems: 4,
      maxItems: 4,
      items: preferenceSchema,
    },
    delivery: unavailableCapabilitySchema,
  },
} as const;

const commonErrors = {
  400: errorResponseSchema(["invalid_request"]),
  401: errorResponseSchema(
    ["authentication_required", "invalid_access_token"],
    { includeBearerChallenge: true },
  ),
  409: errorResponseSchema(["bootstrap_required"]),
  503: errorResponseSchema(["authentication_unavailable", "request_timeout"]),
  500: errorResponseSchema(["internal_error"]),
} as const;

function hasRawHeader(request: FastifyRequest, expectedName: string): boolean {
  for (let index = 0; index < request.raw.rawHeaders.length; index += 2) {
    if (request.raw.rawHeaders[index]?.toLowerCase() === expectedName) {
      return true;
    }
  }
  return false;
}

function assertNoRawBody(request: FastifyRequest): void {
  const contentLength = request.headers["content-length"];
  if (
    (contentLength !== undefined && contentLength !== "0") ||
    request.headers["transfer-encoding"] !== undefined
  ) {
    throw ApiError.invalidRequest();
  }
}

const noBodyAndNoIdempotencyGuard: onRequestHookHandler = (
  request,
  _reply,
  done,
): void => {
  try {
    assertNoRawBody(request);
    if (hasRawHeader(request, "idempotency-key")) {
      throw ApiError.invalidRequest();
    }
    done();
  } catch (error) {
    done(error instanceof Error ? error : ApiError.invalidRequest());
  }
};

const forbidIdempotencyHeader: onRequestHookHandler = (
  request,
  _reply,
  done,
): void => {
  done(
    hasRawHeader(request, "idempotency-key")
      ? ApiError.invalidRequest()
      : undefined,
  );
};

const requireIdempotencyHeader: onRequestHookHandler = (
  request,
  _reply,
  done,
): void => {
  try {
    parseAlertIdempotencyKey(request.raw.rawHeaders);
    done();
  } catch {
    done(ApiError.invalidRequest());
  }
};

function validateCreateBody(request: FastifyRequest): Promise<void> {
  try {
    parsePriceAlertDefinition(request.body);
    return Promise.resolve();
  } catch {
    throw ApiError.invalidRequest();
  }
}

function validateReplaceBody(request: FastifyRequest): Promise<void> {
  try {
    parseReplacePriceAlertRequest(request.body);
    return Promise.resolve();
  } catch {
    throw ApiError.invalidRequest();
  }
}

function validatePreferencesBody(request: FastifyRequest): Promise<void> {
  try {
    parseReplaceNotificationPreferencesRequest(request.body);
    return Promise.resolve();
  } catch {
    throw ApiError.invalidRequest();
  }
}

function mapAlertError(error: unknown): never {
  if (error instanceof InvalidAlertRequestError) {
    throw ApiError.invalidRequest();
  }
  if (error instanceof AlertIdempotencyConflictError) {
    throw ApiError.idempotencyConflict();
  }
  if (error instanceof AlertIdempotencyResourceDeletedError) {
    throw ApiError.idempotencyResourceDeleted();
  }
  if (error instanceof AlertVersionConflictError) {
    throw ApiError.versionConflict();
  }
  if (error instanceof AlertNotFoundError) {
    throw ApiError.alertNotFound();
  }
  throw error;
}

export function registerAlertRoutes(
  app: FastifyInstance,
  authenticateLoopBearer: preHandlerAsyncHookHandler,
  service: AlertService,
): void {
  app.get<{ Querystring: { limit?: number; offset?: number } }>(
    "/v1/alerts",
    {
      schema: {
        operationId: "listAlerts",
        summary: "List inactive price-alert definitions",
        description:
          "Returns only the current owner's inactive stored definitions. Evaluation and delivery remain unavailable.",
        tags: ["alerts"],
        security: [{ privyBearer: [] }],
        querystring: paginationQuerySchema,
        response: { 200: paginatedAlertSchema, ...commonErrors },
      },
      onRequest: noBodyAndNoIdempotencyGuard,
      preHandler: authenticateLoopBearer,
    },
    async (request, reply) => {
      const principal = requireAuthenticatedLoopPrincipal(request);
      try {
        const response = await service.list({
          principal,
          limit: request.query.limit ?? 50,
          offset: request.query.offset ?? 0,
        });
        reply.header("cache-control", "no-store");
        return reply.code(200).send(response);
      } catch (error) {
        return mapAlertError(error);
      }
    },
  );

  app.post(
    "/v1/alerts",
    {
      schema: {
        operationId: "createAlert",
        summary: "Create one inactive price-alert definition",
        description:
          "Idempotently stores one owner-bound inactive definition. It does not start evaluation or delivery.",
        tags: ["alerts"],
        security: [{ privyBearer: [] }],
        headers: createHeadersSchema,
        querystring: emptyQueryStringSchema,
        body: createAlertBodySchema,
        response: {
          200: alertResourceResponseSchema,
          ...commonErrors,
          409: errorResponseSchema([
            "bootstrap_required",
            "idempotency_conflict",
            "idempotency_resource_deleted",
          ]),
        },
      },
      onRequest: requireIdempotencyHeader,
      preValidation: validateCreateBody,
      preHandler: authenticateLoopBearer,
    },
    async (request, reply) => {
      const principal = requireAuthenticatedLoopPrincipal(request);
      try {
        const response = await service.create({
          principal,
          idempotencyKey: parseAlertIdempotencyKey(request.raw.rawHeaders),
          body: request.body,
        });
        reply.header("cache-control", "no-store");
        return reply.code(200).send(response);
      } catch (error) {
        return mapAlertError(error);
      }
    },
  );

  app.get<{ Params: { alert_id: string } }>(
    "/v1/alerts/:alert_id",
    {
      schema: {
        operationId: "getAlert",
        summary: "Get one inactive price-alert definition",
        tags: ["alerts"],
        security: [{ privyBearer: [] }],
        params: alertIdParamsSchema,
        querystring: emptyQueryStringSchema,
        response: {
          200: alertResourceResponseSchema,
          ...commonErrors,
          404: errorResponseSchema(["alert_not_found"]),
        },
      },
      onRequest: noBodyAndNoIdempotencyGuard,
      preHandler: authenticateLoopBearer,
    },
    async (request, reply) => {
      const principal = requireAuthenticatedLoopPrincipal(request);
      try {
        const response = await service.get({
          principal,
          alertId: request.params.alert_id,
        });
        reply.header("cache-control", "no-store");
        return reply.code(200).send(response);
      } catch (error) {
        return mapAlertError(error);
      }
    },
  );

  app.put<{ Params: { alert_id: string } }>(
    "/v1/alerts/:alert_id",
    {
      schema: {
        operationId: "replaceAlert",
        summary: "Replace one inactive price-alert definition",
        description:
          "Uses optimistic concurrency and treats an identical already-applied request as a successful retry.",
        tags: ["alerts"],
        security: [{ privyBearer: [] }],
        params: alertIdParamsSchema,
        querystring: emptyQueryStringSchema,
        body: replaceAlertBodySchema,
        response: {
          200: alertResourceResponseSchema,
          ...commonErrors,
          404: errorResponseSchema(["alert_not_found"]),
          409: errorResponseSchema(["bootstrap_required", "version_conflict"]),
        },
      },
      onRequest: forbidIdempotencyHeader,
      preValidation: validateReplaceBody,
      preHandler: authenticateLoopBearer,
    },
    async (request, reply) => {
      const principal = requireAuthenticatedLoopPrincipal(request);
      try {
        const response = await service.replace({
          principal,
          alertId: request.params.alert_id,
          body: request.body,
        });
        reply.header("cache-control", "no-store");
        return reply.code(200).send(response);
      } catch (error) {
        return mapAlertError(error);
      }
    },
  );

  app.delete<{
    Params: { alert_id: string };
    Querystring: { expected_version: number };
  }>(
    "/v1/alerts/:alert_id",
    {
      schema: {
        operationId: "deleteAlert",
        summary: "Soft-delete one inactive price-alert definition",
        description:
          "Missing, foreign, and already-deleted definitions all return 204 without enumeration.",
        tags: ["alerts"],
        security: [{ privyBearer: [] }],
        params: alertIdParamsSchema,
        querystring: deleteQuerySchema,
        response: {
          204: { type: "null", headers: noStoreResponseHeaders() },
          ...commonErrors,
          409: errorResponseSchema(["bootstrap_required", "version_conflict"]),
        },
      },
      onRequest: noBodyAndNoIdempotencyGuard,
      preHandler: authenticateLoopBearer,
    },
    async (request, reply) => {
      const principal = requireAuthenticatedLoopPrincipal(request);
      try {
        await service.delete({
          principal,
          alertId: request.params.alert_id,
          expectedVersion: request.query.expected_version,
        });
        reply.header("cache-control", "no-store");
        return reply.code(204).send();
      } catch (error) {
        return mapAlertError(error);
      }
    },
  );

  app.get<{ Querystring: { limit?: number; offset?: number } }>(
    "/v1/alerts/history",
    {
      schema: {
        operationId: "listAlertHistory",
        summary: "List persisted real price-alert events",
        description:
          "Returns owner-bound append-only trigger facts newest first. There is no public writer or fixture fallback.",
        tags: ["alerts"],
        security: [{ privyBearer: [] }],
        querystring: paginationQuerySchema,
        response: { 200: historyResponseSchema, ...commonErrors },
      },
      onRequest: noBodyAndNoIdempotencyGuard,
      preHandler: authenticateLoopBearer,
    },
    async (request, reply) => {
      const principal = requireAuthenticatedLoopPrincipal(request);
      try {
        const response = await service.history({
          principal,
          limit: request.query.limit ?? 50,
          offset: request.query.offset ?? 0,
        });
        reply.header("cache-control", "no-store");
        return reply.code(200).send(response);
      } catch (error) {
        return mapAlertError(error);
      }
    },
  );

  app.get(
    "/v1/notification-preferences",
    {
      schema: {
        operationId: "getNotificationPreferences",
        summary: "Get notification delivery intent",
        description:
          "Returns all fixed preferences disabled by default. Delivery remains unavailable regardless of user intent.",
        tags: ["alerts"],
        security: [{ privyBearer: [] }],
        querystring: emptyQueryStringSchema,
        response: { 200: preferenceResourceSchema, ...commonErrors },
      },
      onRequest: noBodyAndNoIdempotencyGuard,
      preHandler: authenticateLoopBearer,
    },
    async (request, reply) => {
      const principal = requireAuthenticatedLoopPrincipal(request);
      try {
        reply.header("cache-control", "no-store");
        return reply
          .code(200)
          .send(await service.getNotificationPreferences(principal));
      } catch (error) {
        return mapAlertError(error);
      }
    },
  );

  app.put(
    "/v1/notification-preferences",
    {
      schema: {
        operationId: "replaceNotificationPreferences",
        summary: "Replace notification delivery intent",
        description:
          "Atomically stores the full fixed preference set. Enabled intent does not imply Firebase or provider delivery.",
        tags: ["alerts"],
        security: [{ privyBearer: [] }],
        querystring: emptyQueryStringSchema,
        body: replacePreferencesBodySchema,
        response: {
          200: preferenceResourceSchema,
          ...commonErrors,
          409: errorResponseSchema(["bootstrap_required", "version_conflict"]),
        },
      },
      onRequest: forbidIdempotencyHeader,
      preValidation: validatePreferencesBody,
      preHandler: authenticateLoopBearer,
    },
    async (request, reply) => {
      const principal = requireAuthenticatedLoopPrincipal(request);
      try {
        reply.header("cache-control", "no-store");
        return reply.code(200).send(
          await service.replaceNotificationPreferences({
            principal,
            body: request.body,
          }),
        );
      } catch (error) {
        return mapAlertError(error);
      }
    },
  );
}
