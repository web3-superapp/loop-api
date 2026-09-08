import type { FastifyInstance } from "fastify";

import { requireAuthenticatedLoopPrincipal } from "../../core/http/authentication.js";
import { assertNoBodyOrQuery } from "../../core/http/request-input.js";
import {
  emptyQueryStringSchema,
  noStoreResponseHeaders,
} from "../../core/http/schemas.js";
import { V2ApiError, v2ErrorResponseSchema } from "../../core/http/v2-error.js";
import { v2ContractVersion } from "../../features/meta/product-policy.js";
import {
  deviceListLimit,
  deviceRiskPolicy,
  securityReasonCodes,
} from "../../features/security/security-contract.js";
import {
  clientVersionMaximumLength,
  clientVersionMinimumLength,
  clientVersionSemver2PatternSource,
} from "../../features/session/client-version.js";
import {
  parseV2DeviceReadMetadata,
  parseV2SessionLogoutMetadata,
  v2DeviceReadHeadersSchema,
  v2SessionLogoutHeadersSchema,
} from "../../features/session/session-contract.js";
import {
  accountReadErrors,
  dateTimeSchema,
  nullableDateTimeSchema,
  uuidPatternSource,
  validateDeviceReadHeaders,
  validateSessionCommandHeaders,
} from "./account-schemas.js";
import type { V2RouteDependencies } from "./index.js";

/**
 * Device sessions (D20, Decision 0037). The list is the owner's
 * `device_sessions` audit projection; remote revocation of another session
 * is a durable idempotent command; revoking the caller's own session or every
 * session is a step-up operation that stays `AUTH_STEP_UP_REQUIRED` until an
 * MFA step exists.
 */

const uuidV4Pattern =
  "^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$";

const deviceSchema = {
  type: "object",
  additionalProperties: false,
  required: [
    "sessionId",
    "deviceId",
    "platform",
    "clientVersion",
    "status",
    "authStrength",
    "isCurrent",
    "createdAt",
    "lastSeenAt",
    "revokedAt",
  ],
  properties: {
    sessionId: { type: "string", pattern: uuidPatternSource },
    deviceId: { type: "string", pattern: uuidV4Pattern },
    platform: { type: "string", enum: ["android", "ios"] },
    clientVersion: {
      type: "string",
      minLength: clientVersionMinimumLength,
      maxLength: clientVersionMaximumLength,
      pattern: clientVersionSemver2PatternSource,
    },
    status: { type: "string", enum: ["active", "revoked"] },
    authStrength: { type: "string", const: "providerAuthenticated" },
    isCurrent: {
      type: "boolean",
      description:
        "True only for the session named by the optional X-Loop-Session-ID request header.",
    },
    createdAt: dateTimeSchema,
    lastSeenAt: {
      ...dateTimeSchema,
      description:
        "Bootstrap observation time; not a continuous presence signal (Decision 0027).",
    },
    revokedAt: nullableDateTimeSchema,
  },
} as const;

const deviceListResourceSchema = {
  type: "object",
  headers: noStoreResponseHeaders(),
  additionalProperties: false,
  required: [
    "devices",
    "currentSessionId",
    "riskSignals",
    "revokeAll",
    "truncated",
    "observedAt",
    "contractVersion",
  ],
  properties: {
    devices: {
      type: "array",
      maxItems: deviceListLimit,
      items: deviceSchema,
      description:
        "Newest first; active sessions before revoked ones. Bounded, not paginated.",
    },
    currentSessionId: {
      anyOf: [{ type: "string", pattern: uuidPatternSource }, { type: "null" }],
    },
    riskSignals: {
      type: "object",
      additionalProperties: false,
      required: ["newSessions24h", "highRiskNewDevice", "policy"],
      properties: {
        newSessions24h: { type: "integer", minimum: 0 },
        highRiskNewDevice: {
          type: "boolean",
          description:
            "newSessions24h >= policy.newSessionThreshold (main-agent ruling 2026-09-08). A hint for the page; no MFA or cooldown is enforced server-side yet.",
        },
        policy: {
          type: "object",
          additionalProperties: false,
          required: ["configVersion", "windowHours", "newSessionThreshold"],
          properties: {
            configVersion: {
              type: "string",
              const: deviceRiskPolicy.configVersion,
            },
            windowHours: {
              type: "integer",
              const: deviceRiskPolicy.windowHours,
            },
            newSessionThreshold: {
              type: "integer",
              const: deviceRiskPolicy.newSessionThreshold,
            },
          },
        },
      },
    },
    revokeAll: {
      type: "object",
      additionalProperties: false,
      required: ["status", "reasonCode"],
      properties: {
        status: { type: "string", const: "unavailable" },
        reasonCode: {
          type: "string",
          const: securityReasonCodes.revokeAllStepUp,
        },
      },
    },
    truncated: { type: "boolean" },
    observedAt: dateTimeSchema,
    contractVersion: { type: "string", const: v2ContractVersion },
  },
} as const;

const revokeResourceSchema = {
  type: "object",
  headers: noStoreResponseHeaders(),
  additionalProperties: false,
  required: [
    "session",
    "effect",
    "providerAccessTerminated",
    "contractVersion",
  ],
  properties: {
    session: {
      type: "object",
      additionalProperties: false,
      required: ["sessionId", "status", "revokedAt"],
      properties: {
        sessionId: { type: "string", pattern: uuidPatternSource },
        status: { type: "string", const: "revoked" },
        revokedAt: dateTimeSchema,
      },
    },
    effect: {
      type: "string",
      const: "auditOnly",
      description:
        "The LOOP audit projection is revoked and a security.event is recorded; LOOP refuses further requests naming this session. The device's Privy access is not terminated (Privy session revocation is a Go/No-Go item).",
    },
    providerAccessTerminated: { type: "boolean", const: false },
    contractVersion: { type: "string", const: v2ContractVersion },
  },
} as const;

const sessionParamsSchema = {
  type: "object",
  additionalProperties: false,
  required: ["sessionId"],
  properties: {
    sessionId: { type: "string", pattern: uuidPatternSource },
  },
} as const;

const revokeErrors = {
  ...accountReadErrors,
  403: v2ErrorResponseSchema(["AUTH_STEP_UP_REQUIRED"]),
  404: v2ErrorResponseSchema(["SESSION_NOT_FOUND"]),
  409: v2ErrorResponseSchema([
    "ACCOUNT_BOOTSTRAP_REQUIRED",
    "IDEMPOTENCY_CONFLICT",
    "VERSION_CONFLICT",
  ]),
  429: v2ErrorResponseSchema(["RATE_LIMITED"]),
} as const;

export function registerV2DeviceRoutes(
  app: FastifyInstance,
  dependencies: V2RouteDependencies,
): void {
  const { authenticateLoopBearer, deviceService } = dependencies;

  app.get(
    "/v2/devices",
    {
      schema: {
        operationId: "listV2Devices",
        summary: "List the account's device sessions",
        description:
          "Owner-bound device-session audit projection with the current-session marker, platform, lastSeenAt, and the high-risk new-device signal. Sessions are never credentials; every call still verifies the Privy Bearer token.",
        tags: ["security"],
        security: [{ privyBearer: [] }],
        headers: v2DeviceReadHeadersSchema,
        querystring: emptyQueryStringSchema,
        response: { 200: deviceListResourceSchema, ...accountReadErrors },
      },
      onRequest: validateDeviceReadHeaders,
      preValidation: assertNoBodyOrQuery,
      preHandler: authenticateLoopBearer,
    },
    async (request, reply) => {
      const resource = await deviceService.list({
        principal: requireAuthenticatedLoopPrincipal(request),
        metadata: parseV2DeviceReadMetadata(request.raw.rawHeaders),
      });
      reply.header("cache-control", "no-store");
      return reply.code(200).send(resource);
    },
  );

  app.post(
    "/v2/devices/:sessionId/revoke",
    {
      schema: {
        operationId: "revokeV2Device",
        summary: "Revoke another device session of the same account",
        description:
          "Durable idempotent revocation (command kind revoke). The target must differ from the caller's X-Loop-Session-ID: revoking the current session is a step-up operation and answers AUTH_STEP_UP_REQUIRED until MFA exists. Missing and foreign sessions are SESSION_NOT_FOUND.",
        tags: ["security"],
        security: [{ privyBearer: [] }],
        headers: v2SessionLogoutHeadersSchema,
        params: sessionParamsSchema,
        querystring: emptyQueryStringSchema,
        response: { 200: revokeResourceSchema, ...revokeErrors },
      },
      onRequest: validateSessionCommandHeaders,
      preValidation: assertNoBodyOrQuery,
      preHandler: authenticateLoopBearer,
    },
    async (request, reply) => {
      const params = request.params as { readonly sessionId: string };
      const resource = await deviceService.revoke({
        principal: requireAuthenticatedLoopPrincipal(request),
        targetSessionId: params.sessionId,
        metadata: parseV2SessionLogoutMetadata(request.raw.rawHeaders),
        requestId: request.id,
      });
      reply.header("cache-control", "no-store");
      return reply.code(200).send(resource);
    },
  );

  app.post(
    "/v2/devices/revoke-all",
    {
      schema: {
        operationId: "revokeAllV2Devices",
        summary: "Revoke every device session (step-up required)",
        description:
          "Always AUTH_STEP_UP_REQUIRED in this step: no MFA step is connected, so the operation is refused before any persistence. Published so the client can show the reason instead of simulating it.",
        tags: ["security"],
        security: [{ privyBearer: [] }],
        headers: v2SessionLogoutHeadersSchema,
        querystring: emptyQueryStringSchema,
        response: { 200: revokeResourceSchema, ...revokeErrors },
      },
      onRequest: validateSessionCommandHeaders,
      preValidation: assertNoBodyOrQuery,
      preHandler: authenticateLoopBearer,
    },
    async (request) => {
      await deviceService.revokeAll({
        principal: requireAuthenticatedLoopPrincipal(request),
        metadata: parseV2SessionLogoutMetadata(request.raw.rawHeaders),
      });
      // revokeAll never resolves in this step; reaching here is a defect.
      throw V2ApiError.fromCode("INTERNAL_ERROR");
    },
  );
}
