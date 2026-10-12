import type { FastifyInstance, FastifyRequest } from "fastify";

import { requireAuthenticatedLoopPrincipal } from "../../core/http/authentication.js";
import { V2ApiError } from "../../core/http/v2-error.js";
import { assertNoBodyOrQuery } from "../../core/http/request-input.js";
import {
  emptyQueryStringSchema,
  noStoreResponseHeaders,
} from "../../core/http/schemas.js";
import { opaqueIdPatternSource } from "../../core/ids/opaque-id.js";
import { notificationCategories } from "../../features/alerts/notification-contract.js";
import { v2ContractVersion } from "../../features/meta/product-policy.js";
import {
  deviceRiskPolicy,
  recentSecurityEventLimit,
  securityCapabilityIds,
  securityCapabilityProjections,
} from "../../features/security/security-contract.js";
import { v2CommonHeadersSchema } from "../../features/session/session-contract.js";
import {
  accountReadErrors,
  dateTimeSchema,
  nullableDateTimeSchema,
  reasonCodeSchema,
  unavailableBlockSchema,
  uuidPatternSource,
  validateReadHeaders,
} from "./account-schemas.js";
import type { V2RouteDependencies } from "./index.js";

/**
 * Security centre (D20, Decision 0037): the six Privy-side security methods
 * are `unavailable` with pending evidence by default (Decision 0129 §4:
 * `?projection=current` reports the client-wired ones); the summary composes facts
 * from the session, approvals, and notification modules without a score.
 */

const securityCapabilitiesResourceSchema = {
  type: "object",
  headers: noStoreResponseHeaders(),
  additionalProperties: false,
  required: ["items", "contractVersion"],
  properties: {
    items: {
      type: "array",
      minItems: securityCapabilityIds.length,
      maxItems: securityCapabilityIds.length,
      items: {
        type: "object",
        additionalProperties: false,
        required: [
          "capabilityId",
          "status",
          "reasonCode",
          "evidence",
          "guideKey",
        ],
        properties: {
          capabilityId: { type: "string", enum: [...securityCapabilityIds] },
          status: {
            type: "string",
            enum: ["unavailable", "available"],
            description:
              "Default projection (pendingOnly, Decision 0037): always unavailable with pending evidence. Decision 0129 §4, projection=current: mfa and autoRecovery are available (confirmed evidence), passkey is available while the API publishes a relying-party association (else unavailable / PASSKEY_RELYING_PARTY_NOT_CONFIGURED), recoveryPassword / socialRecovery / keyExport stay unavailable.",
          },
          reasonCode: {
            anyOf: [reasonCodeSchema, { type: "null" }],
            description: "The unavailability reason; null when available.",
          },
          evidence: {
            type: "object",
            additionalProperties: false,
            required: ["status", "reasonCode"],
            properties: {
              status: {
                type: "string",
                enum: ["pending", "confirmed"],
                description:
                  "pending with an unavailable item; confirmed with an available one (projection=current only).",
              },
              reasonCode: reasonCodeSchema,
              reference: {
                type: "string",
                minLength: 1,
                maxLength: 120,
                description:
                  "Decision 0129 §4: present with confirmed evidence only — where the evidence is recorded (the client step and decision).",
              },
            },
          },
          guideKey: {
            type: "string",
            pattern: "^security\\.capability\\.[a-zA-Z]+\\.howToEnable$",
          },
        },
      },
    },
    contractVersion: { type: "string", const: v2ContractVersion },
  },
} as const;

const blockNumberSchema = {
  type: "string",
  pattern: "^(0|[1-9][0-9]{0,19})$",
} as const;

const devicesBlockSchema = {
  type: "object",
  additionalProperties: false,
  required: [
    "status",
    "deviceCount",
    "activeSessionCount",
    "newSessions24h",
    "highRiskNewDevice",
    "policy",
  ],
  properties: {
    status: { type: "string", const: "available" },
    deviceCount: {
      type: "integer",
      minimum: 0,
      description: "Distinct device IDs with an active session.",
    },
    activeSessionCount: { type: "integer", minimum: 0 },
    newSessions24h: { type: "integer", minimum: 0 },
    highRiskNewDevice: { type: "boolean" },
    policy: {
      type: "object",
      additionalProperties: false,
      required: ["configVersion", "windowHours", "newSessionThreshold"],
      properties: {
        configVersion: {
          type: "string",
          const: deviceRiskPolicy.configVersion,
        },
        windowHours: { type: "integer", const: deviceRiskPolicy.windowHours },
        newSessionThreshold: {
          type: "integer",
          const: deviceRiskPolicy.newSessionThreshold,
        },
      },
    },
  },
} as const;

const approvalsBlockSchema = {
  type: "object",
  additionalProperties: false,
  required: [
    "status",
    "walletId",
    "activeCount",
    "unlimitedCount",
    "freshness",
  ],
  properties: {
    status: { type: "string", const: "available" },
    walletId: { type: "string", pattern: uuidPatternSource },
    activeCount: { type: "integer", minimum: 0 },
    unlimitedCount: { type: "integer", minimum: 0 },
    freshness: {
      type: "object",
      additionalProperties: false,
      required: [
        "indexerBlockNumber",
        "approvalCoverageFromBlockNumber",
        "headBlockNumber",
        "observedAt",
      ],
      properties: {
        indexerBlockNumber: blockNumberSchema,
        approvalCoverageFromBlockNumber: blockNumberSchema,
        headBlockNumber: blockNumberSchema,
        observedAt: dateTimeSchema,
      },
    },
  },
} as const;

const stringMapSchema = (nullable: boolean) =>
  ({
    type: "object",
    additionalProperties: nullable
      ? { anyOf: [{ type: "string" }, { type: "null" }] }
      : { type: "string" },
  }) as const;

const securityEventSchema = {
  type: "object",
  additionalProperties: false,
  required: [
    "notificationId",
    "type",
    "entityRef",
    "contextRoute",
    "contextParams",
    "payload",
    "source",
    "observedAt",
    "readAt",
    "createdAt",
  ],
  properties: {
    // Same table/column as GET /v2/notifications/feed: canonical lowercase
    // UUIDv4 (`notifications.notification_id`), so both routes publish the
    // identical pattern.
    notificationId: { type: "string", pattern: opaqueIdPatternSource },
    type: { type: "string", enum: [...notificationCategories] },
    entityRef: { type: "string", minLength: 3, maxLength: 200 },
    contextRoute: { type: "string", pattern: "^[a-z][a-z0-9-]{0,63}$" },
    contextParams: stringMapSchema(false),
    payload: stringMapSchema(true),
    source: { anyOf: [{ type: "string" }, { type: "null" }] },
    observedAt: nullableDateTimeSchema,
    readAt: nullableDateTimeSchema,
    createdAt: dateTimeSchema,
  },
} as const;

const securitySummaryResourceSchema = {
  type: "object",
  headers: noStoreResponseHeaders(),
  additionalProperties: false,
  required: [
    "devices",
    "approvals",
    "notifications",
    "recentSecurityEvents",
    "observedAt",
    "contractVersion",
  ],
  properties: {
    devices: { oneOf: [devicesBlockSchema, unavailableBlockSchema] },
    approvals: {
      oneOf: [approvalsBlockSchema, unavailableBlockSchema],
      description:
        "Reuses GET /v2/approvals summary for the active wallet. Unavailable when the sendApprovals module, wallet inventory, RPC, or indexer is missing; the reasonCode is the module's own reason.",
    },
    notifications: {
      type: "object",
      additionalProperties: false,
      required: ["securityEvents"],
      properties: {
        securityEvents: {
          type: "object",
          additionalProperties: false,
          required: ["category", "enabled", "locked"],
          properties: {
            category: { type: "string", const: "security.event" },
            enabled: { type: "boolean", const: true },
            locked: { type: "boolean", const: true },
          },
        },
      },
    },
    recentSecurityEvents: {
      oneOf: [
        {
          type: "object",
          additionalProperties: false,
          required: ["status", "items"],
          properties: {
            status: { type: "string", const: "available" },
            items: {
              type: "array",
              maxItems: recentSecurityEventLimit,
              items: securityEventSchema,
            },
          },
        },
        unavailableBlockSchema,
      ],
    },
    observedAt: dateTimeSchema,
    contractVersion: { type: "string", const: v2ContractVersion },
  },
} as const;

/**
 * Decision 0129 §4: no body; the only query key is `projection`, with one of
 * the two values (anything else is 400 INVALID_REQUEST).
 */
function assertCapabilitiesQuery(request: FastifyRequest): Promise<void> {
  const query = request.query as Record<string, unknown>;
  const keys = Object.keys(query);
  if (
    request.body !== undefined ||
    keys.some((key) => key !== "projection") ||
    (keys.length === 1 &&
      !(securityCapabilityProjections as readonly unknown[]).includes(
        query["projection"],
      ))
  ) {
    throw V2ApiError.invalidRequest();
  }
  return Promise.resolve();
}

export function registerV2SecurityRoutes(
  app: FastifyInstance,
  dependencies: V2RouteDependencies,
): void {
  const { authenticateLoopBearer, securityService } = dependencies;

  app.get(
    "/v2/security/capabilities",
    {
      schema: {
        operationId: "listV2SecurityCapabilities",
        summary: "List MFA, passkey, recovery, and key-export availability",
        description:
          "Default (no query, Decision 0037 bytes): every item is unavailable with a PRIVY_<X>_EVIDENCE_PENDING reason. Decision 0129 §4: ?projection=current reports what the client wired through privy_flutter — mfa (TOTP, S60a) and autoRecovery (Privy embedded-wallet default) available with confirmed evidence, passkey (S64) available while the API publishes a relying-party association (Decision 0063) and otherwise unavailable / PASSKEY_RELYING_PARTY_NOT_CONFIGURED; recoveryPassword, socialRecovery and keyExport stay unavailable with their pending reason. Apps whose codec accepts only unavailable must not send projection=current. No local simulation; the key-export page shows an explanation and a non-executable button.",
        tags: ["security"],
        security: [{ privyBearer: [] }],
        headers: v2CommonHeadersSchema,
        querystring: {
          type: "object",
          additionalProperties: false,
          properties: {
            projection: {
              type: "string",
              enum: [...securityCapabilityProjections],
              description:
                "pendingOnly (default) or current (Decision 0129 §4).",
            },
          },
        },
        response: {
          200: securityCapabilitiesResourceSchema,
          ...accountReadErrors,
        },
      },
      onRequest: validateReadHeaders,
      preValidation: assertCapabilitiesQuery,
      preHandler: authenticateLoopBearer,
    },
    async (request, reply) => {
      requireAuthenticatedLoopPrincipal(request);
      reply.header("cache-control", "no-store");
      const { projection } = request.query as { projection?: string };
      return reply.code(200).send(
        securityService.listCapabilities({
          projection: projection === "current" ? "current" : "pendingOnly",
        }),
      );
    },
  );

  app.get(
    "/v2/security/summary",
    {
      schema: {
        operationId: "getV2SecuritySummary",
        summary: "Get the security-centre summary",
        description:
          "Device count, active sessions, approvals summary of the active wallet, the mandatory security notification category, and the latest security.event notifications. No score is computed; each block is available or unavailable with its reason.",
        tags: ["security"],
        security: [{ privyBearer: [] }],
        headers: v2CommonHeadersSchema,
        querystring: emptyQueryStringSchema,
        response: { 200: securitySummaryResourceSchema, ...accountReadErrors },
      },
      onRequest: validateReadHeaders,
      preValidation: assertNoBodyOrQuery,
      preHandler: authenticateLoopBearer,
    },
    async (request, reply) => {
      const resource = await securityService.getSummary({
        principal: requireAuthenticatedLoopPrincipal(request),
      });
      reply.header("cache-control", "no-store");
      return reply.code(200).send(resource);
    },
  );
}
