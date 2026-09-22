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
  pushProviderId,
  pushTokenMaximumLength,
  pushTokenMinimumLength,
  pushTokenPatternSource,
  pushPlatforms,
} from "../../features/push/push-contract.js";
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
  assertNoQuery,
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
 *
 * The push-token pair (Decision 0067) lives here because a token addresses a
 * device session and dies with it: registration binds to the caller's
 * `X-Loop-Session-ID`, and revoking or logging out of that session retires
 * the token in the same transaction.
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
    "sessionShortId",
    "isCurrent",
    "isCurrentDevice",
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
    sessionShortId: {
      type: "string",
      pattern: "^[0-9a-f]{4}$",
      description:
        "Last four hex digits of sessionId: the server-defined short form to show on the row so two sessions of the same device and version stay distinguishable (Decision 0049).",
    },
    isCurrent: {
      type: "boolean",
      description:
        "True only for the session named by the optional X-Loop-Session-ID request header.",
    },
    isCurrentDevice: {
      type: "boolean",
      description:
        "True for every row whose deviceId equals the current session's device, including that device's older sessions (isCurrent false). False for every row when no current session is listed (Decision 0049).",
    },
    createdAt: {
      ...dateTimeSchema,
      description: "First sign-in of this session; show it to the minute.",
    },
    lastSeenAt: {
      ...dateTimeSchema,
      description:
        "Bootstrap observation time; not a continuous presence signal (Decision 0027). Do not render it on the isCurrent row: that session is in use right now.",
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
      description:
        "The X-Loop-Session-ID request header, echoed only when it names one of the rows in devices[]; otherwise null. A non-null value therefore always pairs with exactly one device whose isCurrent is true.",
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

const pushTokenRequestSchema = {
  type: "object",
  additionalProperties: false,
  required: ["platform", "token", "appVersion"],
  properties: {
    platform: {
      type: "string",
      enum: [...pushPlatforms],
      description:
        "Must equal X-Loop-Platform: the session row already records the platform, and a body that disagrees is refused as INVALID_REQUEST.",
    },
    token: {
      type: "string",
      minLength: pushTokenMinimumLength,
      maxLength: pushTokenMaximumLength,
      pattern: pushTokenPatternSource,
      description:
        "FCM registration token. Android registers with FCM directly; iOS registers with FCM through the APNs key held by the same Firebase project. The value is stored for delivery only and is never returned by any endpoint or written to a log.",
    },
    appVersion: {
      type: "string",
      minLength: clientVersionMinimumLength,
      maxLength: clientVersionMaximumLength,
      pattern: clientVersionSemver2PatternSource,
    },
  },
} as const;

const pushTokenRegistrationSchema = {
  type: "object",
  headers: noStoreResponseHeaders(),
  additionalProperties: false,
  required: [
    "registered",
    "pushTokenId",
    "platform",
    "provider",
    "appVersion",
    "observedAt",
    "contractVersion",
  ],
  properties: {
    registered: { type: "boolean", const: true },
    pushTokenId: {
      type: "string",
      pattern: uuidPatternSource,
      description:
        "Opaque stable ID of the registration. Re-sending the same token on the same session keeps this ID; a new token replaces the row and issues a new one.",
    },
    platform: { type: "string", enum: [...pushPlatforms] },
    provider: {
      type: "string",
      const: pushProviderId,
      description: "The single delivery Provider: FCM HTTP v1.",
    },
    appVersion: {
      type: "string",
      minLength: clientVersionMinimumLength,
      maxLength: clientVersionMaximumLength,
      pattern: clientVersionSemver2PatternSource,
    },
    observedAt: {
      ...dateTimeSchema,
      description: "When the server last observed this token.",
    },
    contractVersion: { type: "string", const: v2ContractVersion },
  },
} as const;

const pushTokenRemovalSchema = {
  type: "object",
  headers: noStoreResponseHeaders(),
  additionalProperties: false,
  required: ["registered", "revokedAt", "observedAt", "contractVersion"],
  properties: {
    registered: { type: "boolean", const: false },
    revokedAt: {
      ...nullableDateTimeSchema,
      description:
        "When the active token was retired, or null when the session had none. Both are success: unregistering is idempotent.",
    },
    observedAt: dateTimeSchema,
    contractVersion: { type: "string", const: v2ContractVersion },
  },
} as const;

const pushTokenErrors = {
  ...accountReadErrors,
  404: v2ErrorResponseSchema(["SESSION_NOT_FOUND"]),
  409: v2ErrorResponseSchema([
    "ACCOUNT_BOOTSTRAP_REQUIRED",
    "IDEMPOTENCY_CONFLICT",
    "VERSION_CONFLICT",
  ]),
} as const;

export function registerV2DeviceRoutes(
  app: FastifyInstance,
  dependencies: V2RouteDependencies,
): void {
  const { authenticateLoopBearer, deviceService, pushTokenService } =
    dependencies;

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
    "/v2/devices/push-token",
    {
      schema: {
        operationId: "registerV2DevicePushToken",
        summary: "Register this device session's push token",
        description:
          "Binds one FCM registration token to the caller's active device session (X-Loop-Session-ID). The header device and platform must match the stored session row, otherwise the session is reported as SESSION_NOT_FOUND. The write is refused with CAPABILITY_UNAVAILABLE while no Firebase credential is configured, so a client never holds a token the backend would never use. Idempotent: the same Idempotency-Key replays the first outcome, and re-sending the same token keeps the same pushTokenId.",
        tags: ["security"],
        security: [{ privyBearer: [] }],
        headers: v2SessionLogoutHeadersSchema,
        body: pushTokenRequestSchema,
        querystring: emptyQueryStringSchema,
        response: { 200: pushTokenRegistrationSchema, ...pushTokenErrors },
      },
      onRequest: validateSessionCommandHeaders,
      preValidation: assertNoQuery,
      preHandler: authenticateLoopBearer,
    },
    async (request, reply) => {
      const resource = await pushTokenService.register({
        principal: requireAuthenticatedLoopPrincipal(request),
        metadata: parseV2SessionLogoutMetadata(request.raw.rawHeaders),
        body: request.body,
        requestId: request.id,
      });
      reply.header("cache-control", "no-store");
      return reply.code(200).send(resource);
    },
  );

  app.delete(
    "/v2/devices/push-token",
    {
      schema: {
        operationId: "removeV2DevicePushToken",
        summary: "Remove this device session's push token",
        description:
          "Retires the caller session's active token. Always available, including while push delivery is unavailable: taking an address back must never depend on the Provider. A session with no token answers 200 with revokedAt null.",
        tags: ["security"],
        security: [{ privyBearer: [] }],
        headers: v2SessionLogoutHeadersSchema,
        querystring: emptyQueryStringSchema,
        response: { 200: pushTokenRemovalSchema, ...pushTokenErrors },
      },
      onRequest: validateSessionCommandHeaders,
      preValidation: assertNoBodyOrQuery,
      preHandler: authenticateLoopBearer,
    },
    async (request, reply) => {
      const resource = await pushTokenService.unregister({
        principal: requireAuthenticatedLoopPrincipal(request),
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
