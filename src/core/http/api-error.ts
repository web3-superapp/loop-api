export type ApiErrorCode =
  | "agent_authorization_expired"
  | "agent_authorization_not_found"
  | "agent_authorization_unavailable"
  | "alert_not_found"
  | "authentication_required"
  | "authentication_unavailable"
  | "bootstrap_required"
  | "invalid_access_token"
  | "invalid_request"
  | "idempotency_conflict"
  | "idempotency_resource_deleted"
  | "perp_intent_claim_rate_limited"
  | "perp_intent_expired"
  | "perp_intent_not_found"
  | "perp_intent_stale"
  | "perp_mutation_disabled"
  | "perp_unavailable"
  | "rate_limit_exceeded"
  | "spot_agent_authorization_expired"
  | "spot_agent_authorization_not_found"
  | "spot_intent_claim_rate_limited"
  | "spot_intent_expired"
  | "spot_intent_not_found"
  | "spot_intent_stale"
  | "spot_market_not_found"
  | "spot_unavailable"
  | "stream_unavailable"
  | "transfer_unavailable"
  | "version_conflict"
  | "wallet_binding_required"
  | "request_timeout";

interface ApiErrorOptions {
  readonly statusCode: 400 | 401 | 403 | 404 | 409 | 422 | 429 | 503;
  readonly code: ApiErrorCode;
  readonly safeMessage: string;
  readonly includeBearerChallenge?: boolean;
}

export class ApiError extends Error {
  readonly statusCode: ApiErrorOptions["statusCode"];
  readonly code: ApiErrorCode;
  readonly safeMessage: string;
  readonly includeBearerChallenge: boolean;

  constructor(options: ApiErrorOptions) {
    super(options.safeMessage);
    this.name = "ApiError";
    this.statusCode = options.statusCode;
    this.code = options.code;
    this.safeMessage = options.safeMessage;
    this.includeBearerChallenge = options.includeBearerChallenge ?? false;
  }

  static authenticationRequired(): ApiError {
    return new ApiError({
      statusCode: 401,
      code: "authentication_required",
      safeMessage: "Authentication is required.",
      includeBearerChallenge: true,
    });
  }

  static agentAuthorizationExpired(): ApiError {
    return new ApiError({
      statusCode: 409,
      code: "agent_authorization_expired",
      safeMessage: "The Agent authorization signing request has expired.",
    });
  }

  static agentAuthorizationNotFound(): ApiError {
    return new ApiError({
      statusCode: 404,
      code: "agent_authorization_not_found",
      safeMessage: "The Agent authorization does not exist.",
    });
  }

  static agentAuthorizationUnavailable(): ApiError {
    return new ApiError({
      statusCode: 503,
      code: "agent_authorization_unavailable",
      safeMessage: "Agent authorization is unavailable.",
    });
  }

  static authenticationUnavailable(): ApiError {
    return new ApiError({
      statusCode: 503,
      code: "authentication_unavailable",
      safeMessage: "Authentication is unavailable.",
    });
  }

  static alertNotFound(): ApiError {
    return new ApiError({
      statusCode: 404,
      code: "alert_not_found",
      safeMessage: "The alert does not exist.",
    });
  }

  static bootstrapRequired(): ApiError {
    return new ApiError({
      statusCode: 409,
      code: "bootstrap_required",
      safeMessage: "Bootstrap is required.",
    });
  }

  static invalidAccessToken(): ApiError {
    return new ApiError({
      statusCode: 401,
      code: "invalid_access_token",
      safeMessage: "The access token is invalid.",
      includeBearerChallenge: true,
    });
  }

  static invalidRequest(): ApiError {
    return new ApiError({
      statusCode: 400,
      code: "invalid_request",
      safeMessage: "The request is invalid.",
    });
  }

  static idempotencyConflict(): ApiError {
    return new ApiError({
      statusCode: 409,
      code: "idempotency_conflict",
      safeMessage: "The idempotency key conflicts with another request.",
    });
  }

  static idempotencyResourceDeleted(): ApiError {
    return new ApiError({
      statusCode: 409,
      code: "idempotency_resource_deleted",
      safeMessage:
        "The resource created with this idempotency key has been deleted.",
    });
  }

  static perpIntentExpired(): ApiError {
    return new ApiError({
      statusCode: 409,
      code: "perp_intent_expired",
      safeMessage: "The perpetual intent has expired.",
    });
  }

  static perpIntentClaimRateLimited(): ApiError {
    return new ApiError({
      statusCode: 429,
      code: "perp_intent_claim_rate_limited",
      safeMessage: "Too many unfinished perpetual intent preparations.",
    });
  }

  static perpIntentNotFound(): ApiError {
    return new ApiError({
      statusCode: 404,
      code: "perp_intent_not_found",
      safeMessage: "The perpetual intent does not exist.",
    });
  }

  static perpIntentStale(): ApiError {
    return new ApiError({
      statusCode: 409,
      code: "perp_intent_stale",
      safeMessage: "The perpetual intent must be reviewed again.",
    });
  }

  static perpMutationDisabled(): ApiError {
    return new ApiError({
      statusCode: 403,
      code: "perp_mutation_disabled",
      safeMessage: "Perpetual mutations are disabled.",
    });
  }

  static rateLimitExceeded(): ApiError {
    return new ApiError({
      statusCode: 429,
      code: "rate_limit_exceeded",
      safeMessage: "The token issuance rate limit was exceeded.",
    });
  }

  static perpUnavailable(): ApiError {
    return new ApiError({
      statusCode: 503,
      code: "perp_unavailable",
      safeMessage: "Perpetual account data is unavailable.",
    });
  }

  static streamUnavailable(): ApiError {
    return new ApiError({
      statusCode: 503,
      code: "stream_unavailable",
      safeMessage: "Stream token issuance is unavailable.",
    });
  }

  static transferUnavailable(): ApiError {
    return new ApiError({
      statusCode: 503,
      code: "transfer_unavailable",
      safeMessage: "Transfer operations are unavailable.",
    });
  }

  static versionConflict(): ApiError {
    return new ApiError({
      statusCode: 409,
      code: "version_conflict",
      safeMessage: "The resource has changed. Refresh and try again.",
    });
  }

  static walletBindingRequired(): ApiError {
    return new ApiError({
      statusCode: 409,
      code: "wallet_binding_required",
      safeMessage: "A verified wallet binding is required.",
    });
  }
}
