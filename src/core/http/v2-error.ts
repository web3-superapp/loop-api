import { ApiError, type ApiErrorCode } from "./api-error.js";
import { noStoreResponseHeaders } from "./schemas.js";

export type V2ErrorCategory =
  | "authentication"
  | "authorization"
  | "availability"
  | "conflict"
  | "internal"
  | "rateLimit"
  | "stale"
  | "validation";

export type V2ErrorCode =
  | "ACCOUNT_BOOTSTRAP_REQUIRED"
  | "AUTH_INVALID"
  | "AUTH_REQUIRED"
  | "CAPABILITY_UNAVAILABLE"
  | "DATA_STALE"
  | "IDEMPOTENCY_CONFLICT"
  | "INTERNAL_ERROR"
  | "INVALID_REQUEST"
  | "NOT_FOUND"
  | "PERMISSION_DENIED"
  | "POLICY_BLOCKED"
  | "PROVIDER_DISCONNECTED"
  | "RATE_LIMITED"
  | "REQUEST_TIMEOUT"
  | "SESSION_NOT_FOUND"
  | "VERSION_CONFLICT";

export interface V2ErrorResponse {
  readonly code: V2ErrorCode;
  readonly category: V2ErrorCategory;
  readonly retryable: boolean;
  readonly userMessageKey: string;
  readonly correlationId: string;
  readonly detailsSafe: null;
  readonly providerReferenceSafe: null;
}

type V2ErrorStatusCode = 400 | 401 | 403 | 404 | 409 | 422 | 429 | 500 | 503;

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

const invalidRequestDescriptor = Object.freeze({
  code: "INVALID_REQUEST",
  category: "validation",
  retryable: false,
  userMessageKey: "errors.request.invalid",
} satisfies V2ErrorDescriptor);

const notFoundDescriptor = Object.freeze({
  code: "NOT_FOUND",
  category: "validation",
  retryable: false,
  userMessageKey: "errors.resource.notFound",
} satisfies V2ErrorDescriptor);

const apiErrorDescriptors = Object.freeze({
  agent_authorization_expired: {
    code: "DATA_STALE",
    category: "stale",
    retryable: false,
    userMessageKey: "errors.authorization.expired",
  },
  agent_authorization_not_found: notFoundDescriptor,
  agent_authorization_unavailable: {
    code: "CAPABILITY_UNAVAILABLE",
    category: "availability",
    retryable: true,
    userMessageKey: "errors.capability.unavailable",
  },
  alert_not_found: notFoundDescriptor,
  authentication_required: {
    code: "AUTH_REQUIRED",
    category: "authentication",
    retryable: false,
    userMessageKey: "errors.auth.required",
  },
  authentication_unavailable: {
    code: "PROVIDER_DISCONNECTED",
    category: "availability",
    retryable: true,
    userMessageKey: "errors.provider.disconnected",
  },
  bootstrap_required: {
    code: "ACCOUNT_BOOTSTRAP_REQUIRED",
    category: "authentication",
    retryable: false,
    userMessageKey: "errors.account.bootstrapRequired",
  },
  invalid_access_token: {
    code: "AUTH_INVALID",
    category: "authentication",
    retryable: false,
    userMessageKey: "errors.auth.invalid",
  },
  invalid_request: invalidRequestDescriptor,
  idempotency_conflict: {
    code: "IDEMPOTENCY_CONFLICT",
    category: "conflict",
    retryable: false,
    userMessageKey: "errors.idempotency.conflict",
  },
  idempotency_resource_deleted: {
    code: "IDEMPOTENCY_CONFLICT",
    category: "conflict",
    retryable: false,
    userMessageKey: "errors.idempotency.resourceUnavailable",
  },
  perp_intent_claim_rate_limited: {
    code: "RATE_LIMITED",
    category: "rateLimit",
    retryable: true,
    userMessageKey: "errors.rateLimit.exceeded",
  },
  perp_intent_expired: {
    code: "DATA_STALE",
    category: "stale",
    retryable: false,
    userMessageKey: "errors.intent.expired",
  },
  perp_intent_not_found: notFoundDescriptor,
  perp_intent_stale: {
    code: "DATA_STALE",
    category: "stale",
    retryable: false,
    userMessageKey: "errors.intent.stale",
  },
  perp_mutation_disabled: {
    code: "POLICY_BLOCKED",
    category: "authorization",
    retryable: false,
    userMessageKey: "errors.policy.blocked",
  },
  perp_unavailable: {
    code: "CAPABILITY_UNAVAILABLE",
    category: "availability",
    retryable: true,
    userMessageKey: "errors.capability.unavailable",
  },
  rate_limit_exceeded: {
    code: "RATE_LIMITED",
    category: "rateLimit",
    retryable: true,
    userMessageKey: "errors.rateLimit.exceeded",
  },
  request_timeout: {
    code: "REQUEST_TIMEOUT",
    category: "availability",
    retryable: true,
    userMessageKey: "errors.request.timeout",
  },
  spot_agent_authorization_expired: {
    code: "DATA_STALE",
    category: "stale",
    retryable: false,
    userMessageKey: "errors.authorization.expired",
  },
  spot_agent_authorization_not_found: notFoundDescriptor,
  spot_intent_claim_rate_limited: {
    code: "RATE_LIMITED",
    category: "rateLimit",
    retryable: true,
    userMessageKey: "errors.rateLimit.exceeded",
  },
  spot_intent_expired: {
    code: "DATA_STALE",
    category: "stale",
    retryable: false,
    userMessageKey: "errors.intent.expired",
  },
  spot_intent_not_found: notFoundDescriptor,
  spot_intent_stale: {
    code: "DATA_STALE",
    category: "stale",
    retryable: false,
    userMessageKey: "errors.intent.stale",
  },
  spot_market_not_found: notFoundDescriptor,
  spot_unavailable: {
    code: "CAPABILITY_UNAVAILABLE",
    category: "availability",
    retryable: true,
    userMessageKey: "errors.capability.unavailable",
  },
  stream_unavailable: {
    code: "CAPABILITY_UNAVAILABLE",
    category: "availability",
    retryable: true,
    userMessageKey: "errors.capability.unavailable",
  },
  transfer_unavailable: {
    code: "CAPABILITY_UNAVAILABLE",
    category: "availability",
    retryable: true,
    userMessageKey: "errors.capability.unavailable",
  },
  version_conflict: {
    code: "VERSION_CONFLICT",
    category: "conflict",
    retryable: false,
    userMessageKey: "errors.version.conflict",
  },
  wallet_binding_required: {
    code: "POLICY_BLOCKED",
    category: "authorization",
    retryable: false,
    userMessageKey: "errors.wallet.bindingRequired",
  },
} satisfies Readonly<Record<ApiErrorCode, V2ErrorDescriptor>>);

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

  static invalidRequest(): V2ApiError {
    return new V2ApiError({
      statusCode: 400,
      ...invalidRequestDescriptor,
    });
  }

  static idempotencyConflict(): V2ApiError {
    return new V2ApiError({
      statusCode: 409,
      code: "IDEMPOTENCY_CONFLICT",
      category: "conflict",
      retryable: false,
      userMessageKey: "errors.idempotency.conflict",
    });
  }

  static notFound(): V2ApiError {
    return new V2ApiError({
      statusCode: 404,
      ...notFoundDescriptor,
    });
  }

  static sessionNotFound(): V2ApiError {
    return new V2ApiError({
      statusCode: 404,
      code: "SESSION_NOT_FOUND",
      category: "validation",
      retryable: false,
      userMessageKey: "errors.session.notFound",
    });
  }

  static rateLimited(): V2ApiError {
    return new V2ApiError({
      statusCode: 429,
      code: "RATE_LIMITED",
      category: "rateLimit",
      retryable: true,
      userMessageKey: "errors.rateLimit.exceeded",
    });
  }

  static versionConflict(): V2ApiError {
    return new V2ApiError({
      statusCode: 409,
      code: "VERSION_CONFLICT",
      category: "conflict",
      retryable: false,
      userMessageKey: "errors.version.conflict",
    });
  }

  static capabilityUnavailable(): V2ApiError {
    return new V2ApiError({
      statusCode: 503,
      code: "CAPABILITY_UNAVAILABLE",
      category: "availability",
      retryable: true,
      userMessageKey: "errors.capability.unavailable",
    });
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
      statusCode: 503,
      descriptor: apiErrorDescriptors.request_timeout,
      includeBearerChallenge: false,
    };
  }

  if (
    details.code !== undefined &&
    fastifyInvalidRequestCodes.has(details.code)
  ) {
    return {
      statusCode: 400,
      descriptor: invalidRequestDescriptor,
      includeBearerChallenge: false,
    };
  }

  return {
    statusCode: 500,
    descriptor: {
      code: "INTERNAL_ERROR",
      category: "internal",
      retryable: false,
      userMessageKey: "errors.internal",
    },
    includeBearerChallenge: false,
  };
}

function createProjection(
  statusCode: V2ErrorStatusCode,
  descriptor: V2ErrorDescriptor,
  correlationId: string,
  includeBearerChallenge: boolean,
): V2ErrorProjection {
  return Object.freeze({
    statusCode,
    includeBearerChallenge,
    response: Object.freeze({
      code: descriptor.code,
      category: descriptor.category,
      retryable: descriptor.retryable,
      userMessageKey: descriptor.userMessageKey,
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
      apiErrorDescriptors[error.code],
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
        enum: [
          "authentication",
          "authorization",
          "availability",
          "conflict",
          "internal",
          "rateLimit",
          "stale",
          "validation",
        ],
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
