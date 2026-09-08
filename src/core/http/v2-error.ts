import { ApiError, type ApiErrorCode } from "./api-error.js";
import { noStoreResponseHeaders } from "./schemas.js";

export const v2ErrorCategories = Object.freeze([
  "authentication",
  "authorization",
  "availability",
  "conflict",
  "internal",
  "rateLimit",
  "stale",
  "validation",
] as const);

export type V2ErrorCategory = (typeof v2ErrorCategories)[number];

export type V2ErrorStatusCode =
  400 | 401 | 403 | 404 | 409 | 422 | 429 | 500 | 503;

export interface V2ErrorCatalogEntry {
  readonly statusCode: V2ErrorStatusCode;
  readonly category: V2ErrorCategory;
  readonly retryable: boolean;
  readonly userMessageKey: string;
  readonly includeBearerChallenge: boolean;
}

/**
 * The complete V2 machine error code family (03 §13.3 plus the codes already
 * used by the session slice). Each code has exactly one category, retryable
 * flag, and localization key; a route may only narrow the set of codes it can
 * return, never redefine an entry.
 */
export const v2ErrorCatalog = Object.freeze({
  ACCOUNT_BOOTSTRAP_REQUIRED: {
    statusCode: 409,
    category: "authentication",
    retryable: false,
    userMessageKey: "errors.account.bootstrapRequired",
    includeBearerChallenge: false,
  },
  ALIAS_BLOCKED: {
    statusCode: 422,
    category: "validation",
    retryable: false,
    userMessageKey: "errors.alias.blocked",
    includeBearerChallenge: false,
  },
  ALIAS_RESERVED: {
    statusCode: 422,
    category: "validation",
    retryable: false,
    userMessageKey: "errors.alias.reserved",
    includeBearerChallenge: false,
  },
  AUTH_INVALID: {
    statusCode: 401,
    category: "authentication",
    retryable: false,
    userMessageKey: "errors.auth.invalid",
    includeBearerChallenge: true,
  },
  AUTH_REQUIRED: {
    statusCode: 401,
    category: "authentication",
    retryable: false,
    userMessageKey: "errors.auth.required",
    includeBearerChallenge: true,
  },
  AUTH_STEP_UP_REQUIRED: {
    statusCode: 403,
    category: "authentication",
    retryable: false,
    userMessageKey: "errors.auth.stepUpRequired",
    includeBearerChallenge: false,
  },
  CAPABILITY_UNAVAILABLE: {
    statusCode: 503,
    category: "availability",
    retryable: true,
    userMessageKey: "errors.capability.unavailable",
    includeBearerChallenge: false,
  },
  CHAIN_MISMATCH: {
    statusCode: 422,
    category: "validation",
    retryable: false,
    userMessageKey: "errors.chain.mismatch",
    includeBearerChallenge: false,
  },
  DATA_STALE: {
    statusCode: 409,
    category: "stale",
    retryable: false,
    userMessageKey: "errors.data.stale",
    includeBearerChallenge: false,
  },
  IDEMPOTENCY_CONFLICT: {
    statusCode: 409,
    category: "conflict",
    retryable: false,
    userMessageKey: "errors.idempotency.conflict",
    includeBearerChallenge: false,
  },
  INDEXING_DELAYED: {
    statusCode: 503,
    category: "availability",
    retryable: true,
    userMessageKey: "errors.indexing.delayed",
    includeBearerChallenge: false,
  },
  INSUFFICIENT_BALANCE: {
    statusCode: 409,
    category: "conflict",
    retryable: false,
    userMessageKey: "errors.balance.insufficient",
    includeBearerChallenge: false,
  },
  INTERNAL_ERROR: {
    statusCode: 500,
    category: "internal",
    retryable: false,
    userMessageKey: "errors.internal",
    includeBearerChallenge: false,
  },
  INVALID_REQUEST: {
    statusCode: 400,
    category: "validation",
    retryable: false,
    userMessageKey: "errors.request.invalid",
    includeBearerChallenge: false,
  },
  MAINTENANCE: {
    statusCode: 503,
    category: "availability",
    retryable: true,
    userMessageKey: "errors.service.maintenance",
    includeBearerChallenge: false,
  },
  NOT_FOUND: {
    statusCode: 404,
    category: "validation",
    retryable: false,
    userMessageKey: "errors.resource.notFound",
    includeBearerChallenge: false,
  },
  PERMISSION_DENIED: {
    statusCode: 403,
    category: "authorization",
    retryable: false,
    userMessageKey: "errors.permission.denied",
    includeBearerChallenge: false,
  },
  POLICY_BLOCKED: {
    statusCode: 403,
    category: "authorization",
    retryable: false,
    userMessageKey: "errors.policy.blocked",
    includeBearerChallenge: false,
  },
  PROFILE_ACTIVATION_REQUIRED: {
    statusCode: 409,
    category: "conflict",
    retryable: false,
    userMessageKey: "errors.profile.activationRequired",
    includeBearerChallenge: false,
  },
  PROVIDER_DISCONNECTED: {
    statusCode: 503,
    category: "availability",
    retryable: true,
    userMessageKey: "errors.provider.disconnected",
    includeBearerChallenge: false,
  },
  QUOTE_EXPIRED: {
    statusCode: 409,
    category: "stale",
    retryable: false,
    userMessageKey: "errors.quote.expired",
    includeBearerChallenge: false,
  },
  RATE_LIMITED: {
    statusCode: 429,
    category: "rateLimit",
    retryable: true,
    userMessageKey: "errors.rateLimit.exceeded",
    includeBearerChallenge: false,
  },
  REGION_BLOCKED: {
    statusCode: 403,
    category: "authorization",
    retryable: false,
    userMessageKey: "errors.region.blocked",
    includeBearerChallenge: false,
  },
  REQUEST_TIMEOUT: {
    statusCode: 503,
    category: "availability",
    retryable: true,
    userMessageKey: "errors.request.timeout",
    includeBearerChallenge: false,
  },
  SESSION_NOT_FOUND: {
    statusCode: 404,
    category: "validation",
    retryable: false,
    userMessageKey: "errors.session.notFound",
    includeBearerChallenge: false,
  },
  SIMULATION_FAILED: {
    statusCode: 409,
    category: "conflict",
    retryable: false,
    userMessageKey: "errors.simulation.failed",
    includeBearerChallenge: false,
  },
  SUBMISSION_UNKNOWN: {
    statusCode: 409,
    category: "conflict",
    retryable: false,
    userMessageKey: "errors.submission.unknown",
    includeBearerChallenge: false,
  },
  VALIDATION_FAILED: {
    statusCode: 422,
    category: "validation",
    retryable: false,
    userMessageKey: "errors.validation.failed",
    includeBearerChallenge: false,
  },
  VERSION_CONFLICT: {
    statusCode: 409,
    category: "conflict",
    retryable: false,
    userMessageKey: "errors.version.conflict",
    includeBearerChallenge: false,
  },
} as const satisfies Readonly<Record<string, V2ErrorCatalogEntry>>);

export type V2ErrorCode = keyof typeof v2ErrorCatalog;

export const v2ErrorCodes = Object.freeze(
  Object.keys(v2ErrorCatalog).sort() as V2ErrorCode[],
);

export interface V2ErrorResponse {
  readonly code: V2ErrorCode;
  readonly category: V2ErrorCategory;
  readonly retryable: boolean;
  readonly userMessageKey: string;
  readonly correlationId: string;
  readonly detailsSafe: null;
  readonly providerReferenceSafe: null;
}

interface V2ErrorDescriptor {
  readonly code: V2ErrorCode;
  readonly category: V2ErrorCategory;
  readonly retryable: boolean;
  readonly userMessageKey: string;
}

interface V2ApiErrorOptions extends V2ErrorDescriptor {
  readonly statusCode: V2ErrorStatusCode;
  readonly includeBearerChallenge?: boolean;
}

export interface V2ErrorProjection {
  readonly statusCode: V2ErrorStatusCode;
  readonly includeBearerChallenge: boolean;
  readonly response: V2ErrorResponse;
}

function descriptor(code: V2ErrorCode): V2ErrorDescriptor {
  const entry = v2ErrorCatalog[code];
  return {
    code,
    category: entry.category,
    retryable: entry.retryable,
    userMessageKey: entry.userMessageKey,
  };
}

/**
 * Frozen V1 `ApiError` codes thrown inside a V2 request are projected onto
 * the V2 catalog. The HTTP status and Bearer challenge come from the thrown
 * error; category, retryable, and localization key come from the catalog.
 */
const apiErrorCodeMap = Object.freeze({
  agent_authorization_expired: "DATA_STALE",
  agent_authorization_not_found: "NOT_FOUND",
  agent_authorization_unavailable: "CAPABILITY_UNAVAILABLE",
  alert_not_found: "NOT_FOUND",
  authentication_required: "AUTH_REQUIRED",
  authentication_unavailable: "PROVIDER_DISCONNECTED",
  bootstrap_required: "ACCOUNT_BOOTSTRAP_REQUIRED",
  invalid_access_token: "AUTH_INVALID",
  invalid_request: "INVALID_REQUEST",
  idempotency_conflict: "IDEMPOTENCY_CONFLICT",
  idempotency_resource_deleted: "IDEMPOTENCY_CONFLICT",
  perp_intent_claim_rate_limited: "RATE_LIMITED",
  perp_intent_expired: "DATA_STALE",
  perp_intent_not_found: "NOT_FOUND",
  perp_intent_stale: "DATA_STALE",
  perp_mutation_disabled: "POLICY_BLOCKED",
  perp_unavailable: "CAPABILITY_UNAVAILABLE",
  rate_limit_exceeded: "RATE_LIMITED",
  request_timeout: "REQUEST_TIMEOUT",
  spot_agent_authorization_expired: "DATA_STALE",
  spot_agent_authorization_not_found: "NOT_FOUND",
  spot_intent_claim_rate_limited: "RATE_LIMITED",
  spot_intent_expired: "DATA_STALE",
  spot_intent_not_found: "NOT_FOUND",
  spot_intent_stale: "DATA_STALE",
  spot_market_not_found: "NOT_FOUND",
  spot_unavailable: "CAPABILITY_UNAVAILABLE",
  stream_unavailable: "CAPABILITY_UNAVAILABLE",
  transfer_unavailable: "CAPABILITY_UNAVAILABLE",
  version_conflict: "VERSION_CONFLICT",
  wallet_binding_required: "POLICY_BLOCKED",
} as const satisfies Readonly<Record<ApiErrorCode, V2ErrorCode>>);

export class V2ApiError extends Error {
  readonly statusCode: V2ErrorStatusCode;
  readonly code: V2ErrorCode;
  readonly category: V2ErrorCategory;
  readonly retryable: boolean;
  readonly userMessageKey: string;
  readonly includeBearerChallenge: boolean;

  constructor(options: V2ApiErrorOptions) {
    super(options.userMessageKey);
    this.name = "V2ApiError";
    this.statusCode = options.statusCode;
    this.code = options.code;
    this.category = options.category;
    this.retryable = options.retryable;
    this.userMessageKey = options.userMessageKey;
    this.includeBearerChallenge = options.includeBearerChallenge ?? false;
  }

  /** Create the canonical error for a catalog code. */
  static fromCode(code: V2ErrorCode): V2ApiError {
    const entry = v2ErrorCatalog[code];
    return new V2ApiError({
      statusCode: entry.statusCode,
      includeBearerChallenge: entry.includeBearerChallenge,
      ...descriptor(code),
    });
  }

  static invalidRequest(): V2ApiError {
    return V2ApiError.fromCode("INVALID_REQUEST");
  }

  static idempotencyConflict(): V2ApiError {
    return V2ApiError.fromCode("IDEMPOTENCY_CONFLICT");
  }

  static notFound(): V2ApiError {
    return V2ApiError.fromCode("NOT_FOUND");
  }

  static sessionNotFound(): V2ApiError {
    return V2ApiError.fromCode("SESSION_NOT_FOUND");
  }

  static rateLimited(): V2ApiError {
    return V2ApiError.fromCode("RATE_LIMITED");
  }

  static versionConflict(): V2ApiError {
    return V2ApiError.fromCode("VERSION_CONFLICT");
  }

  static capabilityUnavailable(): V2ApiError {
    return V2ApiError.fromCode("CAPABILITY_UNAVAILABLE");
  }
}

function inspectRequestError(error: unknown): {
  readonly code: string | undefined;
} {
  if (typeof error !== "object" || error === null) {
    return { code: undefined };
  }

  return {
    code:
      "code" in error && typeof error.code === "string"
        ? error.code
        : undefined,
  };
}

const fastifyInvalidRequestCodes = new Set([
  "FST_ERR_BAD_URL",
  "FST_ERR_CTP_BODY_TOO_LARGE",
  "FST_ERR_CTP_EMPTY_JSON_BODY",
  "FST_ERR_CTP_INVALID_CONTENT_LENGTH",
  "FST_ERR_CTP_INVALID_JSON_BODY",
  "FST_ERR_CTP_INVALID_MEDIA_TYPE",
  "FST_ERR_MAX_PARAM_LENGTH",
  "FST_ERR_VALIDATION",
]);

function descriptorForGenericError(error: unknown): {
  readonly statusCode: V2ErrorStatusCode;
  readonly descriptor: V2ErrorDescriptor;
  readonly includeBearerChallenge: boolean;
} {
  const details = inspectRequestError(error);

  if (details.code === "FST_ERR_HANDLER_TIMEOUT") {
    return {
      statusCode: v2ErrorCatalog.REQUEST_TIMEOUT.statusCode,
      descriptor: descriptor("REQUEST_TIMEOUT"),
      includeBearerChallenge: false,
    };
  }

  if (
    details.code !== undefined &&
    fastifyInvalidRequestCodes.has(details.code)
  ) {
    return {
      statusCode: v2ErrorCatalog.INVALID_REQUEST.statusCode,
      descriptor: descriptor("INVALID_REQUEST"),
      includeBearerChallenge: false,
    };
  }

  return {
    statusCode: v2ErrorCatalog.INTERNAL_ERROR.statusCode,
    descriptor: descriptor("INTERNAL_ERROR"),
    includeBearerChallenge: false,
  };
}

function createProjection(
  statusCode: V2ErrorStatusCode,
  errorDescriptor: V2ErrorDescriptor,
  correlationId: string,
  includeBearerChallenge: boolean,
): V2ErrorProjection {
  return Object.freeze({
    statusCode,
    includeBearerChallenge,
    response: Object.freeze({
      code: errorDescriptor.code,
      category: errorDescriptor.category,
      retryable: errorDescriptor.retryable,
      userMessageKey: errorDescriptor.userMessageKey,
      correlationId,
      detailsSafe: null,
      providerReferenceSafe: null,
    }),
  });
}

export function projectV2Error(
  error: unknown,
  correlationId: string,
): V2ErrorProjection {
  if (error instanceof V2ApiError) {
    return createProjection(
      error.statusCode,
      error,
      correlationId,
      error.includeBearerChallenge,
    );
  }

  if (error instanceof ApiError) {
    return createProjection(
      error.statusCode,
      descriptor(apiErrorCodeMap[error.code]),
      correlationId,
      error.includeBearerChallenge,
    );
  }

  const generic = descriptorForGenericError(error);
  return createProjection(
    generic.statusCode,
    generic.descriptor,
    correlationId,
    generic.includeBearerChallenge,
  );
}

export function isV2RequestPath(rawUrl: string | undefined): boolean {
  if (rawUrl === undefined) {
    return false;
  }

  const queryIndex = rawUrl.indexOf("?");
  const path = queryIndex === -1 ? rawUrl : rawUrl.slice(0, queryIndex);
  return path === "/v2" || path.startsWith("/v2/");
}

export function v2ErrorResponseSchema(
  codes: readonly V2ErrorCode[],
  options: { readonly includeBearerChallenge?: boolean } = {},
) {
  return {
    type: "object",
    headers: noStoreResponseHeaders(options.includeBearerChallenge ?? false),
    additionalProperties: false,
    required: [
      "code",
      "category",
      "retryable",
      "userMessageKey",
      "correlationId",
      "detailsSafe",
      "providerReferenceSafe",
    ],
    properties: {
      code: { type: "string", enum: codes },
      category: {
        type: "string",
        enum: [...v2ErrorCategories],
      },
      retryable: { type: "boolean" },
      userMessageKey: {
        type: "string",
        pattern: "^errors\\.[A-Za-z0-9.]+$",
        maxLength: 128,
      },
      correlationId: { type: "string", format: "uuid" },
      detailsSafe: {
        anyOf: [
          { type: "object", additionalProperties: true },
          { type: "null" },
        ],
      },
      providerReferenceSafe: {
        anyOf: [
          {
            type: "string",
            minLength: 1,
            maxLength: 128,
            pattern: "^[A-Za-z0-9._:-]+$",
          },
          { type: "null" },
        ],
      },
    },
  } as const;
}
