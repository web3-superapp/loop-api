import type { FastifyRequest, onRequestHookHandler } from "fastify";

import { V2ApiError, v2ErrorResponseSchema } from "../../core/http/v2-error.js";
import { reasonCodePatternSource } from "../../features/chain/chain-contract.js";
import { hasIdempotencyKeyHeader } from "../../features/community/community-contract.js";
import {
  parseV2CommonRequestMetadata,
  parseV2DeviceReadMetadata,
  parseV2SessionLogoutMetadata,
  parseV2WriteRequestMetadata,
} from "../../features/session/session-contract.js";

/**
 * Shared schema fragments and header hooks for the D20 routes (devices,
 * security, settings, support; Decision 0037).
 */

export const uuidPatternSource =
  "^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$";

export const reasonCodeSchema = {
  type: "string",
  pattern: reasonCodePatternSource,
} as const;

export const unavailableBlockSchema = {
  type: "object",
  additionalProperties: false,
  required: ["status", "reasonCode"],
  properties: {
    status: { type: "string", const: "unavailable" },
    reasonCode: reasonCodeSchema,
  },
} as const;

export const dateTimeSchema = { type: "string", format: "date-time" } as const;
export const nullableDateTimeSchema = {
  anyOf: [dateTimeSchema, { type: "null" }],
} as const;

export const accountReadErrors = {
  400: v2ErrorResponseSchema(["INVALID_REQUEST"]),
  401: v2ErrorResponseSchema(["AUTH_REQUIRED", "AUTH_INVALID"], {
    includeBearerChallenge: true,
  }),
  409: v2ErrorResponseSchema([
    "ACCOUNT_BOOTSTRAP_REQUIRED",
    "VERSION_CONFLICT",
  ]),
  500: v2ErrorResponseSchema(["INTERNAL_ERROR"]),
  503: v2ErrorResponseSchema([
    "CAPABILITY_UNAVAILABLE",
    "PROVIDER_DISCONNECTED",
    "REQUEST_TIMEOUT",
  ]),
} as const;

export function validateReadHeaders(request: FastifyRequest): Promise<void> {
  parseV2CommonRequestMetadata(request.raw.rawHeaders);
  if (hasIdempotencyKeyHeader(request.raw.rawHeaders)) {
    throw V2ApiError.invalidRequest();
  }
  return Promise.resolve();
}

export function validateDeviceReadHeaders(
  request: FastifyRequest,
): Promise<void> {
  parseV2DeviceReadMetadata(request.raw.rawHeaders);
  if (hasIdempotencyKeyHeader(request.raw.rawHeaders)) {
    throw V2ApiError.invalidRequest();
  }
  return Promise.resolve();
}

/** Session-scoped commands reuse the logout header set (Decision 0027). */
export function validateSessionCommandHeaders(
  request: FastifyRequest,
): Promise<void> {
  parseV2SessionLogoutMetadata(request.raw.rawHeaders);
  return Promise.resolve();
}

/**
 * CAS replacements are idempotent through `expectedVersion`; a client
 * `Idempotency-Key` is rejected so a lost-response retry is never mistaken
 * for a durable command replay (Decision 0030).
 */
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

export function assertNoQuery(request: FastifyRequest): Promise<void> {
  const query = request.query as Record<string, unknown>;
  if (Object.keys(query).length > 0) {
    throw V2ApiError.invalidRequest();
  }
  return Promise.resolve();
}
