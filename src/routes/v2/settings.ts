import type { FastifyInstance } from "fastify";

import { requireAuthenticatedLoopPrincipal } from "../../core/http/authentication.js";
import { assertNoBodyOrQuery } from "../../core/http/request-input.js";
import {
  emptyQueryStringSchema,
  noStoreResponseHeaders,
} from "../../core/http/schemas.js";
import { v2ErrorResponseSchema } from "../../core/http/v2-error.js";
import { v2ContractVersion } from "../../features/meta/product-policy.js";
import { maximumRecordVersion } from "../../features/profile/profile-v2-contract.js";
import { v2CommonHeadersSchema } from "../../features/session/session-contract.js";
import { accountSettingsFixedValues } from "../../features/settings/account-settings-repository.js";
import { settingsPolicy } from "../../features/settings/settings-service.js";
import {
  accountReadErrors,
  assertNoQuery,
  nullableDateTimeSchema,
  validateCasWriteHeaders,
  validateReadHeaders,
} from "./account-schemas.js";
import type { V2RouteDependencies } from "./index.js";

/**
 * Account settings (D20, Decision 0037). Both values are product constants
 * in this step; the route is the CAS slot they will share with later
 * account-level settings, and a write of any other value is refused.
 */

const settingsValuesSchema = {
  type: "object",
  additionalProperties: false,
  required: ["displayCurrency", "language"],
  properties: {
    displayCurrency: {
      type: "string",
      const: accountSettingsFixedValues.displayCurrency,
      description: "Fixed product constant; read-only in this step.",
    },
    language: {
      type: "string",
      const: accountSettingsFixedValues.language,
      description: "Fixed product constant; read-only in this step.",
    },
  },
} as const;

const settingsResourceSchema = {
  type: "object",
  headers: noStoreResponseHeaders(),
  additionalProperties: false,
  required: ["settings", "version", "updatedAt", "policy", "contractVersion"],
  properties: {
    settings: settingsValuesSchema,
    version: { type: "integer", minimum: 0, maximum: maximumRecordVersion },
    updatedAt: nullableDateTimeSchema,
    policy: {
      type: "object",
      additionalProperties: false,
      required: ["configVersion", "fixed", "localOnly"],
      properties: {
        configVersion: { type: "string", const: settingsPolicy.configVersion },
        fixed: settingsValuesSchema,
        localOnly: {
          type: "array",
          minItems: settingsPolicy.localOnly.length,
          maxItems: settingsPolicy.localOnly.length,
          items: { type: "string", enum: [...settingsPolicy.localOnly] },
          description:
            "Preferences the backend does not store (reduceMotion, theme); the device keeps them.",
        },
      },
    },
    contractVersion: { type: "string", const: v2ContractVersion },
  },
} as const;

const replaceSettingsRequestSchema = {
  type: "object",
  additionalProperties: false,
  required: ["expectedVersion", "settings"],
  properties: {
    expectedVersion: {
      type: "integer",
      minimum: 0,
      maximum: maximumRecordVersion,
    },
    settings: {
      type: "object",
      additionalProperties: false,
      required: ["displayCurrency", "language"],
      properties: {
        displayCurrency: {
          type: "string",
          minLength: 1,
          maxLength: 16,
          description:
            "Must equal the fixed value USD; any other value is VALIDATION_FAILED.",
        },
        language: {
          type: "string",
          minLength: 1,
          maxLength: 16,
          description:
            "Must equal the fixed value zh-CN; any other value is VALIDATION_FAILED.",
        },
      },
    },
  },
} as const;

const casWriteErrors = {
  ...accountReadErrors,
  422: v2ErrorResponseSchema(["VALIDATION_FAILED"]),
} as const;

export function registerV2SettingsRoutes(
  app: FastifyInstance,
  dependencies: V2RouteDependencies,
): void {
  const { authenticateLoopBearer, settingsService } = dependencies;

  app.get(
    "/v2/settings",
    {
      schema: {
        operationId: "getV2Settings",
        summary: "Get the account-level settings",
        description:
          "Version 0 with the fixed defaults when no row exists; nothing is written by a read.",
        tags: ["settings"],
        security: [{ privyBearer: [] }],
        headers: v2CommonHeadersSchema,
        querystring: emptyQueryStringSchema,
        response: { 200: settingsResourceSchema, ...accountReadErrors },
      },
      onRequest: validateReadHeaders,
      preValidation: assertNoBodyOrQuery,
      preHandler: authenticateLoopBearer,
    },
    async (request, reply) => {
      const resource = await settingsService.get({
        principal: requireAuthenticatedLoopPrincipal(request),
      });
      reply.header("cache-control", "no-store");
      return reply.code(200).send(resource);
    },
  );

  app.put(
    "/v2/settings",
    {
      schema: {
        operationId: "replaceV2Settings",
        summary: "Replace the account-level settings",
        description:
          "Compare-and-swap keyed by expectedVersion; Idempotency-Key is not accepted. expectedVersion equal to the committed version commits version+1; the version immediately before it with identical content is the lost-response retry; anything else is VERSION_CONFLICT. Fixed values are read-only: a different value is VALIDATION_FAILED.",
        tags: ["settings"],
        security: [{ privyBearer: [] }],
        headers: v2CommonHeadersSchema,
        querystring: emptyQueryStringSchema,
        body: replaceSettingsRequestSchema,
        response: { 200: settingsResourceSchema, ...casWriteErrors },
      },
      onRequest: validateCasWriteHeaders,
      preValidation: assertNoQuery,
      preHandler: authenticateLoopBearer,
    },
    async (request, reply) => {
      const resource = await settingsService.replace({
        principal: requireAuthenticatedLoopPrincipal(request),
        body: request.body,
      });
      reply.header("cache-control", "no-store");
      return reply.code(200).send(resource);
    },
  );
}
