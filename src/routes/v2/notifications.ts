import type { FastifyInstance } from "fastify";

import { requireAuthenticatedLoopPrincipal } from "../../core/http/authentication.js";
import { emptyQueryStringSchema } from "../../core/http/schemas.js";
import {
  notificationFeedLimits,
  priceAlertListLimits,
} from "../../features/alerts/notification-contract.js";
import {
  assertNoBody,
  assertNoBodyOrQuery,
  assertNoQuery,
} from "./chain-schemas.js";
import type { V2RouteDependencies } from "./index.js";
import {
  alertIdParamsSchema,
  commandIdempotencyKey,
  createPriceAlertRequestSchema,
  deleteAlertQuerySchema,
  listQuerySchema,
  notificationCasErrors,
  notificationCommandErrors,
  notificationEnvelopeSchema,
  notificationFeedResourceSchema,
  notificationIdParamsSchema,
  notificationPreferencesResourceSchema,
  notificationReadErrors,
  priceAlertEnvelopeSchema,
  priceAlertListResourceSchema,
  replaceNotificationPreferencesRequestSchema,
  replacePriceAlertRequestSchema,
  v2CommandHeadersSchema,
  v2CommonHeadersSchema,
  validateCommandHeaders,
  validateNoIdempotencyHeaders,
} from "./notifications-schemas.js";

/**
 * V2 notifications module routes (D14, Decision 0034): price alerts, the
 * context notification feed, and the ten-category preferences. Registered
 * only when `V2_MODULES_ENABLED` contains `notifications`. The module's
 * `pushNotifications` capability stays unavailable: nothing here delivers a
 * push.
 */

interface AlertParams {
  readonly alertId: string;
}

interface NotificationParams {
  readonly notificationId: string;
}

export function registerV2NotificationRoutes(
  app: FastifyInstance,
  dependencies: V2RouteDependencies,
): void {
  const { authenticateLoopBearer, alertV2Service, notificationService } =
    dependencies;

  app.get(
    "/v2/alerts",
    {
      schema: {
        operationId: "listV2PriceAlerts",
        summary: "List the caller's price alerts",
        description:
          "Newest first with an opaque cursor. State is active, triggered (one-shot; replace to re-arm), or expired. Delivery is always unavailable: a trigger only produces a context notification in the feed.",
        tags: ["notifications"],
        security: [{ privyBearer: [] }],
        headers: v2CommonHeadersSchema,
        querystring: listQuerySchema(priceAlertListLimits.maximum),
        response: {
          200: priceAlertListResourceSchema,
          ...notificationReadErrors,
        },
      },
      onRequest: validateNoIdempotencyHeaders,
      preValidation: assertNoBody,
      preHandler: authenticateLoopBearer,
    },
    async (request, reply) => {
      const query = request.query as {
        readonly cursor?: unknown;
        readonly limit?: unknown;
      };
      const resource = await alertV2Service.list({
        principal: requireAuthenticatedLoopPrincipal(request),
        ...(query.cursor === undefined ? {} : { cursor: query.cursor }),
        ...(query.limit === undefined ? {} : { limit: query.limit }),
      });
      reply.header("cache-control", "no-store");
      return reply.code(200).send(resource);
    },
  );

  app.post(
    "/v2/alerts",
    {
      schema: {
        operationId: "createV2PriceAlert",
        summary: "Create a price alert",
        description:
          "Idempotent on the Idempotency-Key: the same key with the same definition returns the original alert, a different definition is IDEMPOTENCY_CONFLICT. The asset must be a readable registry row and the expiry must be in the future (VALIDATION_FAILED otherwise).",
        tags: ["notifications"],
        security: [{ privyBearer: [] }],
        headers: v2CommandHeadersSchema,
        querystring: emptyQueryStringSchema,
        body: createPriceAlertRequestSchema,
        response: {
          200: priceAlertEnvelopeSchema,
          201: priceAlertEnvelopeSchema,
          ...notificationCommandErrors,
        },
      },
      onRequest: validateCommandHeaders,
      preValidation: assertNoQuery,
      preHandler: authenticateLoopBearer,
    },
    async (request, reply) => {
      const result = await alertV2Service.create({
        principal: requireAuthenticatedLoopPrincipal(request),
        idempotencyKey: commandIdempotencyKey(request),
        body: request.body,
      });
      reply.header("cache-control", "no-store");
      return reply.code(result.created ? 201 : 200).send(result.resource);
    },
  );

  app.get(
    "/v2/alerts/:alertId",
    {
      schema: {
        operationId: "getV2PriceAlert",
        summary: "Get one price alert",
        tags: ["notifications"],
        security: [{ privyBearer: [] }],
        headers: v2CommonHeadersSchema,
        params: alertIdParamsSchema,
        querystring: emptyQueryStringSchema,
        response: { 200: priceAlertEnvelopeSchema, ...notificationReadErrors },
      },
      onRequest: validateNoIdempotencyHeaders,
      preValidation: assertNoBodyOrQuery,
      preHandler: authenticateLoopBearer,
    },
    async (request, reply) => {
      const params = request.params as AlertParams;
      const resource = await alertV2Service.get({
        principal: requireAuthenticatedLoopPrincipal(request),
        alertId: params.alertId,
      });
      reply.header("cache-control", "no-store");
      return reply.code(200).send(resource);
    },
  );

  app.put(
    "/v2/alerts/:alertId",
    {
      schema: {
        operationId: "replaceV2PriceAlert",
        summary: "Replace a price alert",
        description:
          "Compare-and-swap on expectedVersion; an identical retry returns the committed alert, a stale version is VERSION_CONFLICT. A replacement re-arms a triggered alert. Idempotency-Key is rejected.",
        tags: ["notifications"],
        security: [{ privyBearer: [] }],
        headers: v2CommonHeadersSchema,
        params: alertIdParamsSchema,
        querystring: emptyQueryStringSchema,
        body: replacePriceAlertRequestSchema,
        response: { 200: priceAlertEnvelopeSchema, ...notificationCasErrors },
      },
      onRequest: validateNoIdempotencyHeaders,
      preValidation: assertNoQuery,
      preHandler: authenticateLoopBearer,
    },
    async (request, reply) => {
      const params = request.params as AlertParams;
      const resource = await alertV2Service.replace({
        principal: requireAuthenticatedLoopPrincipal(request),
        alertId: params.alertId,
        body: request.body,
      });
      reply.header("cache-control", "no-store");
      return reply.code(200).send(resource);
    },
  );

  app.delete(
    "/v2/alerts/:alertId",
    {
      schema: {
        operationId: "deleteV2PriceAlert",
        summary: "Delete a price alert",
        description:
          "Version-protected soft delete. Missing, foreign, and already-deleted alerts all return 204 without enumeration; a stale version is VERSION_CONFLICT.",
        tags: ["notifications"],
        security: [{ privyBearer: [] }],
        headers: v2CommonHeadersSchema,
        params: alertIdParamsSchema,
        querystring: deleteAlertQuerySchema,
        response: {
          204: { type: "null", headers: noStoreHeaders() },
          ...notificationCasErrors,
        },
      },
      onRequest: validateNoIdempotencyHeaders,
      preValidation: assertNoBody,
      preHandler: authenticateLoopBearer,
    },
    async (request, reply) => {
      const params = request.params as AlertParams;
      const query = request.query as { readonly expectedVersion: unknown };
      await alertV2Service.delete({
        principal: requireAuthenticatedLoopPrincipal(request),
        alertId: params.alertId,
        expectedVersion: query.expectedVersion,
      });
      reply.header("cache-control", "no-store");
      return reply.code(204).send();
    },
  );

  app.get(
    "/v2/notifications/feed",
    {
      schema: {
        operationId: "getV2NotificationFeed",
        summary: "List context notifications",
        description:
          "Newest first with an opaque cursor and the unread count. Each row names its entity and the client route to open; there is no separate notification centre and no push delivery.",
        tags: ["notifications"],
        security: [{ privyBearer: [] }],
        headers: v2CommonHeadersSchema,
        querystring: listQuerySchema(notificationFeedLimits.maximum),
        response: {
          200: notificationFeedResourceSchema,
          ...notificationReadErrors,
        },
      },
      onRequest: validateNoIdempotencyHeaders,
      preValidation: assertNoBody,
      preHandler: authenticateLoopBearer,
    },
    async (request, reply) => {
      const query = request.query as {
        readonly cursor?: unknown;
        readonly limit?: unknown;
      };
      const resource = await notificationService.listFeed({
        principal: requireAuthenticatedLoopPrincipal(request),
        ...(query.cursor === undefined ? {} : { cursor: query.cursor }),
        ...(query.limit === undefined ? {} : { limit: query.limit }),
      });
      reply.header("cache-control", "no-store");
      return reply.code(200).send(resource);
    },
  );

  app.post(
    "/v2/notifications/:notificationId/read",
    {
      schema: {
        operationId: "readV2Notification",
        summary: "Acknowledge one notification as read",
        description:
          "Naturally idempotent: an already-read notification keeps its first readAt. The Idempotency-Key is required by the V2 write convention and is not bound to a durable command.",
        tags: ["notifications"],
        security: [{ privyBearer: [] }],
        headers: v2CommandHeadersSchema,
        params: notificationIdParamsSchema,
        querystring: emptyQueryStringSchema,
        response: {
          200: notificationEnvelopeSchema,
          ...notificationCommandErrors,
        },
      },
      onRequest: validateCommandHeaders,
      preValidation: assertNoBodyOrQuery,
      preHandler: authenticateLoopBearer,
    },
    async (request, reply) => {
      const params = request.params as NotificationParams;
      const resource = await notificationService.markRead({
        principal: requireAuthenticatedLoopPrincipal(request),
        notificationId: params.notificationId,
      });
      reply.header("cache-control", "no-store");
      return reply.code(200).send(resource);
    },
  );

  app.get(
    "/v2/notification-preferences",
    {
      schema: {
        operationId: "getV2NotificationPreferences",
        summary: "Get the ten-category notification preferences",
        description:
          "security.event is always enabled and locked. Enabled is intent only; push delivery is unavailable.",
        tags: ["notifications"],
        security: [{ privyBearer: [] }],
        headers: v2CommonHeadersSchema,
        querystring: emptyQueryStringSchema,
        response: {
          200: notificationPreferencesResourceSchema,
          ...notificationReadErrors,
        },
      },
      onRequest: validateNoIdempotencyHeaders,
      preValidation: assertNoBodyOrQuery,
      preHandler: authenticateLoopBearer,
    },
    async (request, reply) => {
      const resource = await notificationService.getPreferences({
        principal: requireAuthenticatedLoopPrincipal(request),
      });
      reply.header("cache-control", "no-store");
      return reply.code(200).send(resource);
    },
  );

  app.put(
    "/v2/notification-preferences",
    {
      schema: {
        operationId: "replaceV2NotificationPreferences",
        summary: "Replace the ten-category notification preferences",
        description:
          "Compare-and-swap on expectedVersion. All ten categories are required; security.event must be true (false is INVALID_REQUEST). An identical retry returns the committed resource. Idempotency-Key is rejected.",
        tags: ["notifications"],
        security: [{ privyBearer: [] }],
        headers: v2CommonHeadersSchema,
        querystring: emptyQueryStringSchema,
        body: replaceNotificationPreferencesRequestSchema,
        response: {
          200: notificationPreferencesResourceSchema,
          ...notificationCasErrors,
        },
      },
      onRequest: validateNoIdempotencyHeaders,
      preValidation: assertNoQuery,
      preHandler: authenticateLoopBearer,
    },
    async (request, reply) => {
      const resource = await notificationService.replacePreferences({
        principal: requireAuthenticatedLoopPrincipal(request),
        body: request.body,
      });
      reply.header("cache-control", "no-store");
      return reply.code(200).send(resource);
    },
  );
}

function noStoreHeaders() {
  return {
    "cache-control": { type: "string", const: "no-store" },
    "x-request-id": { type: "string", format: "uuid" },
  } as const;
}
