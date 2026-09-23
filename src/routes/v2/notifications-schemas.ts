import type { FastifyRequest, onRequestHookHandler } from "fastify";

import { noStoreResponseHeaders } from "../../core/http/schemas.js";
import { V2ApiError, v2ErrorResponseSchema } from "../../core/http/v2-error.js";
import { opaqueIdPatternSource } from "../../core/ids/opaque-id.js";
import { priceAlertV2Conditions } from "../../database/alert-v2-repository.js";
import {
  hasIdempotencyKeyHeader,
  parseV2CommandMetadata,
  v2CommandHeadersSchema,
} from "../../features/community/community-contract.js";
import {
  assetIdPatternSource,
  assetStatuses,
} from "../../features/chain/chain-contract.js";
import {
  mandatoryNotificationCategory,
  notificationCategories,
  notificationFeedLimits,
  optionalNotificationCategories,
  priceAlertListLimits,
} from "../../features/alerts/notification-contract.js";
import { v2ContractVersion } from "../../features/meta/product-policy.js";
import {
  parseV2CommonRequestMetadata,
  parseV2WriteRequestMetadata,
} from "../../features/session/session-contract.js";
import { v2CommonHeadersSchema } from "./chain-schemas.js";
import { reasonCodePatternSource } from "../../features/chain/chain-contract.js";

/**
 * Route schemas for V2 price alerts, the notification feed, and the
 * ten-category preferences (Decision 0034).
 */

/**
 * Push delivery state (Decision 0067). `available` means a Firebase
 * credential, the push repository and the notifications module are all
 * composed; `unavailable` carries the reason code. The in-app feed is the
 * authoritative record in both states.
 */
const pushDeliverySchema = {
  type: "object",
  additionalProperties: false,
  required: ["status", "reasonCode"],
  properties: {
    status: { type: "string", enum: ["available", "unavailable"] },
    reasonCode: {
      anyOf: [
        { type: "string", pattern: reasonCodePatternSource },
        { type: "null" },
      ],
    },
  },
} as const;

const dateTimeSchema = { type: "string", format: "date-time" } as const;
const nullableDateTimeSchema = {
  anyOf: [dateTimeSchema, { type: "null" }],
} as const;

const thresholdSchema = {
  type: "string",
  minLength: 1,
  maxLength: 96,
  pattern: "^(0|[1-9][0-9]{0,77})(\\.[0-9]{1,18})?$",
  description: "Positive decimal string in USD; never a JavaScript number.",
} as const;

const cursorSchema = {
  type: "string",
  minLength: 3,
  maxLength: 1_536,
  pattern: "^[A-Za-z0-9_-]+\\.[A-Za-z0-9_-]+$",
} as const;

const priceAlertResourceSchema = {
  type: "object",
  additionalProperties: false,
  required: [
    "alertId",
    "assetId",
    "asset",
    "condition",
    "threshold",
    "expiresAt",
    "state",
    "triggeredAt",
    "lastEvaluatedAt",
    "delivery",
    "version",
    "createdAt",
    "updatedAt",
  ],
  properties: {
    alertId: { type: "string", pattern: opaqueIdPatternSource },
    assetId: { type: "string", pattern: assetIdPatternSource },
    asset: {
      anyOf: [
        {
          type: "object",
          additionalProperties: false,
          required: ["symbol", "name", "decimals", "status"],
          properties: {
            symbol: { type: "string", minLength: 1, maxLength: 32 },
            name: { type: "string", minLength: 1, maxLength: 128 },
            decimals: { type: "integer", minimum: 0, maximum: 36 },
            status: { type: "string", enum: [...assetStatuses] },
          },
        },
        { type: "null" },
      ],
    },
    condition: { type: "string", enum: [...priceAlertV2Conditions] },
    threshold: thresholdSchema,
    expiresAt: nullableDateTimeSchema,
    state: {
      type: "string",
      enum: ["active", "triggered", "expired"],
      description:
        "active: armed for the evaluator lane; triggered: fired once, replace to re-arm; expired: past expiresAt without firing.",
    },
    triggeredAt: nullableDateTimeSchema,
    lastEvaluatedAt: nullableDateTimeSchema,
    delivery: pushDeliverySchema,
    version: { type: "integer", minimum: 1 },
    createdAt: dateTimeSchema,
    updatedAt: dateTimeSchema,
  },
} as const;

export const priceAlertEnvelopeSchema = {
  type: "object",
  headers: noStoreResponseHeaders(),
  additionalProperties: false,
  required: ["alert", "contractVersion"],
  properties: {
    alert: priceAlertResourceSchema,
    contractVersion: { type: "string", const: v2ContractVersion },
  },
} as const;

export const priceAlertListResourceSchema = {
  type: "object",
  headers: noStoreResponseHeaders(),
  additionalProperties: false,
  required: ["items", "nextCursor", "contractVersion"],
  properties: {
    items: {
      type: "array",
      maxItems: priceAlertListLimits.maximum,
      items: priceAlertResourceSchema,
    },
    nextCursor: { anyOf: [cursorSchema, { type: "null" }] },
    contractVersion: { type: "string", const: v2ContractVersion },
  },
} as const;

const definitionProperties = {
  assetId: { type: "string", pattern: assetIdPatternSource },
  condition: { type: "string", enum: [...priceAlertV2Conditions] },
  threshold: thresholdSchema,
  expiresAt: {
    anyOf: [
      { type: "string", format: "date-time", maxLength: 64 },
      { type: "null" },
    ],
  },
} as const;

export const createPriceAlertRequestSchema = {
  type: "object",
  additionalProperties: false,
  required: ["assetId", "condition", "threshold", "expiresAt"],
  properties: definitionProperties,
} as const;

export const replacePriceAlertRequestSchema = {
  type: "object",
  additionalProperties: false,
  required: [
    "expectedVersion",
    "assetId",
    "condition",
    "threshold",
    "expiresAt",
  ],
  properties: {
    expectedVersion: { type: "integer", minimum: 1, maximum: 2_147_483_647 },
    ...definitionProperties,
  },
} as const;

export const alertIdParamsSchema = {
  type: "object",
  additionalProperties: false,
  required: ["alertId"],
  properties: { alertId: { type: "string", pattern: opaqueIdPatternSource } },
} as const;

export const deleteAlertQuerySchema = {
  type: "object",
  additionalProperties: false,
  required: ["expectedVersion"],
  properties: {
    expectedVersion: { type: "integer", minimum: 1, maximum: 2_147_483_647 },
  },
} as const;

export const listQuerySchema = (maximum: number) =>
  ({
    type: "object",
    additionalProperties: false,
    properties: {
      cursor: cursorSchema,
      limit: { type: "integer", minimum: 1, maximum },
    },
  }) as const;

const notificationSchema = {
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
    notificationId: { type: "string", pattern: opaqueIdPatternSource },
    type: { type: "string", enum: [...notificationCategories] },
    entityRef: {
      type: "string",
      pattern: "^[a-z][A-Za-z0-9]{0,31}:[A-Za-z0-9._:-]{1,160}$",
      description:
        "Kind-prefixed opaque reference of the entity the notification is about.",
    },
    contextRoute: {
      type: "string",
      pattern: "^[a-z][a-z0-9-]{0,63}$",
      description: "Client route to open; parameters are in contextParams.",
    },
    contextParams: {
      type: "object",
      additionalProperties: { type: "string", maxLength: 256 },
      maxProperties: 8,
    },
    payload: {
      type: "object",
      additionalProperties: {
        anyOf: [{ type: "string", maxLength: 512 }, { type: "null" }],
      },
      maxProperties: 16,
      description:
        "Display facts only; every value is a string with provenance in the same object. The bound admits a 280-code-point community rejection reason (Decision 0072).",
    },
    source: {
      anyOf: [
        { type: "string", pattern: "^[a-z][a-z0-9_]{0,63}$" },
        { type: "null" },
      ],
    },
    observedAt: nullableDateTimeSchema,
    readAt: nullableDateTimeSchema,
    createdAt: dateTimeSchema,
  },
} as const;

export const notificationFeedResourceSchema = {
  type: "object",
  headers: noStoreResponseHeaders(),
  additionalProperties: false,
  required: ["items", "nextCursor", "unreadCount", "push", "contractVersion"],
  properties: {
    items: {
      type: "array",
      maxItems: notificationFeedLimits.maximum,
      items: notificationSchema,
    },
    nextCursor: { anyOf: [cursorSchema, { type: "null" }] },
    unreadCount: { type: "integer", minimum: 0 },
    push: pushDeliverySchema,
    contractVersion: { type: "string", const: v2ContractVersion },
  },
} as const;

export const notificationEnvelopeSchema = {
  type: "object",
  headers: noStoreResponseHeaders(),
  additionalProperties: false,
  required: ["notification", "contractVersion"],
  properties: {
    notification: notificationSchema,
    contractVersion: { type: "string", const: v2ContractVersion },
  },
} as const;

export const notificationIdParamsSchema = {
  type: "object",
  additionalProperties: false,
  required: ["notificationId"],
  properties: {
    notificationId: { type: "string", pattern: opaqueIdPatternSource },
  },
} as const;

const categoryProjectionSchema = {
  type: "object",
  additionalProperties: false,
  required: ["enabled", "locked"],
  properties: {
    enabled: { type: "boolean" },
    locked: { type: "boolean" },
  },
} as const;

export const notificationPreferencesResourceSchema = {
  type: "object",
  headers: noStoreResponseHeaders(),
  additionalProperties: false,
  required: ["version", "updatedAt", "categories", "push", "contractVersion"],
  properties: {
    version: { type: "integer", minimum: 0 },
    updatedAt: nullableDateTimeSchema,
    categories: {
      type: "object",
      additionalProperties: false,
      required: [...notificationCategories],
      properties: Object.fromEntries(
        notificationCategories.map((category) => [
          category,
          category === mandatoryNotificationCategory
            ? {
                type: "object",
                additionalProperties: false,
                required: ["enabled", "locked"],
                properties: {
                  enabled: { type: "boolean", const: true },
                  locked: { type: "boolean", const: true },
                },
              }
            : categoryProjectionSchema,
        ]),
      ),
    },
    push: pushDeliverySchema,
    contractVersion: { type: "string", const: v2ContractVersion },
  },
} as const;

export const replaceNotificationPreferencesRequestSchema = {
  type: "object",
  additionalProperties: false,
  required: ["expectedVersion", "categories"],
  properties: {
    expectedVersion: { type: "integer", minimum: 0, maximum: 2_147_483_647 },
    categories: {
      type: "object",
      additionalProperties: false,
      required: [...notificationCategories],
      properties: {
        ...Object.fromEntries(
          optionalNotificationCategories.map((category) => [
            category,
            { type: "boolean" },
          ]),
        ),
        [mandatoryNotificationCategory]: {
          type: "boolean",
          const: true,
          description:
            "Mandatory and locked. It must be sent as true; sending false is INVALID_REQUEST, never silently corrected.",
        },
      },
    },
  },
} as const;

export const notificationReadErrors = {
  400: v2ErrorResponseSchema(["INVALID_REQUEST"]),
  401: v2ErrorResponseSchema(["AUTH_REQUIRED", "AUTH_INVALID"], {
    includeBearerChallenge: true,
  }),
  404: v2ErrorResponseSchema(["NOT_FOUND"]),
  409: v2ErrorResponseSchema(["ACCOUNT_BOOTSTRAP_REQUIRED"]),
  500: v2ErrorResponseSchema(["INTERNAL_ERROR"]),
  503: v2ErrorResponseSchema(["CAPABILITY_UNAVAILABLE", "REQUEST_TIMEOUT"]),
} as const;

export const notificationCasErrors = {
  ...notificationReadErrors,
  409: v2ErrorResponseSchema([
    "ACCOUNT_BOOTSTRAP_REQUIRED",
    "VERSION_CONFLICT",
  ]),
  422: v2ErrorResponseSchema(["CHAIN_MISMATCH", "VALIDATION_FAILED"]),
} as const;

export const notificationCommandErrors = {
  ...notificationReadErrors,
  409: v2ErrorResponseSchema([
    "ACCOUNT_BOOTSTRAP_REQUIRED",
    "IDEMPOTENCY_CONFLICT",
  ]),
  422: v2ErrorResponseSchema(["CHAIN_MISMATCH", "VALIDATION_FAILED"]),
} as const;

/** Reads and compare-and-swap writes reject an Idempotency-Key (Decision 0030). */
export const validateNoIdempotencyHeaders: onRequestHookHandler = (
  request,
  _reply,
  done,
): void => {
  try {
    parseV2CommonRequestMetadata(request.raw.rawHeaders);
    if (hasIdempotencyKeyHeader(request.raw.rawHeaders)) {
      throw V2ApiError.invalidRequest();
    }
    done();
  } catch (error) {
    done(error instanceof Error ? error : V2ApiError.invalidRequest());
  }
};

/** CAS writes: no Idempotency-Key; platform/device headers validated if present. */
export const validateCasWriteHeaders: onRequestHookHandler = (
  request,
  _reply,
  done,
): void => {
  try {
    parseV2WriteRequestMetadata(request.raw.rawHeaders);
    if (hasIdempotencyKeyHeader(request.raw.rawHeaders)) {
      throw V2ApiError.invalidRequest();
    }
    done();
  } catch (error) {
    done(error instanceof Error ? error : V2ApiError.invalidRequest());
  }
};

/** Commands require exactly one canonical UUIDv4 Idempotency-Key. */
export const validateCommandHeaders: onRequestHookHandler = (
  request,
  _reply,
  done,
): void => {
  try {
    parseV2CommandMetadata(request.raw.rawHeaders);
    done();
  } catch (error) {
    done(error instanceof Error ? error : V2ApiError.invalidRequest());
  }
};

export function commandIdempotencyKey(request: FastifyRequest): string {
  return parseV2CommandMetadata(request.raw.rawHeaders).idempotencyKey;
}

export { v2CommandHeadersSchema, v2CommonHeadersSchema };
