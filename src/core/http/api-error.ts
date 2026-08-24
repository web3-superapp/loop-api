export type ApiErrorCode =
  | "authentication_required"
  | "authentication_unavailable"
  | "bootstrap_required"
  | "invalid_access_token"
  | "invalid_request"
  | "rate_limit_exceeded"
  | "stream_unavailable"
  | "request_timeout";

interface ApiErrorOptions {
  readonly statusCode: 400 | 401 | 409 | 429 | 503;
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

  static authenticationUnavailable(): ApiError {
    return new ApiError({
      statusCode: 503,
      code: "authentication_unavailable",
      safeMessage: "Authentication is unavailable.",
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

  static rateLimitExceeded(): ApiError {
    return new ApiError({
      statusCode: 429,
      code: "rate_limit_exceeded",
      safeMessage: "The token issuance rate limit was exceeded.",
    });
  }

  static streamUnavailable(): ApiError {
    return new ApiError({
      statusCode: 503,
      code: "stream_unavailable",
      safeMessage: "Stream token issuance is unavailable.",
    });
  }
}
