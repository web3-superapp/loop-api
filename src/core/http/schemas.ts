import type { ApiErrorCode } from "./api-error.js";

export const streamUserIdPattern = "^loop_[a-z0-9_-]{8,58}$";

export function noStoreResponseHeaders(includeBearerChallenge = false) {
  return {
    "cache-control": {
      type: "string",
      const: "no-store",
      description: "Sensitive and operational responses are never cached",
    },
    "x-request-id": {
      type: "string",
      format: "uuid",
      description: "Server-generated request correlation ID",
    },
    ...(includeBearerChallenge
      ? {
          "www-authenticate": {
            type: "string",
            const: 'Bearer realm="loop-api"',
            description: "Privy Bearer authentication challenge",
          },
        }
      : {}),
  } as const;
}

export function errorResponseSchema(
  codes: readonly (ApiErrorCode | "internal_error" | "not_found")[],
  options: { readonly includeBearerChallenge?: boolean } = {},
) {
  return {
    type: "object",
    headers: noStoreResponseHeaders(options.includeBearerChallenge ?? false),
    additionalProperties: false,
    required: ["code", "message", "request_id"],
    properties: {
      code: { type: "string", enum: codes },
      message: { type: "string", minLength: 1 },
      request_id: { type: "string", format: "uuid" },
    },
  } as const;
}

export const emptyQueryStringSchema = {
  type: "object",
  properties: {},
  additionalProperties: false,
} as const;
