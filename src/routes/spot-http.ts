import type { FastifyRequest, onRequestHookHandler } from "fastify";

import { ApiError, type ApiErrorCode } from "../core/http/api-error.js";
import {
  errorResponseSchema,
  noStoreResponseHeaders,
} from "../core/http/schemas.js";
import {
  InvalidSpotRequestError,
  SpotUnavailableError,
  SpotVersionConflictError,
  SpotWalletBindingRequiredError,
} from "../features/spot/spot-errors.js";
import { InvalidSpotPrincipalError } from "../features/spot/spot-principal.js";

export type SpotApiErrorCode =
  | "spot_unavailable"
  | "spot_market_not_found"
  | "spot_intent_not_found"
  | "spot_intent_expired"
  | "spot_intent_stale"
  | "spot_intent_claim_rate_limited"
  | "spot_agent_authorization_not_found"
  | "spot_agent_authorization_expired";

type SpotApiErrorStatus = 404 | 409 | 429 | 503;

export const uuidPattern =
  "^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$";
export const canonicalPositiveDecimalPattern =
  "^(?:[1-9][0-9]*(?:\\.[0-9]+)?|0\\.[0-9]*[1-9][0-9]*)$";
export const canonicalNonnegativeDecimalPattern =
  "^(?:0|[1-9][0-9]*)(?:\\.[0-9]+)?$";
export const bindingVersionPattern = "^(?:0|[1-9][0-9]{0,18})$";

export function spotApiError(
  statusCode: SpotApiErrorStatus,
  code: SpotApiErrorCode,
  safeMessage: string,
): ApiError {
  return new ApiError({
    statusCode,
    code,
    safeMessage,
  });
}

export function spotErrorResponseSchema(
  codes: readonly (ApiErrorCode | "internal_error" | "not_found")[],
) {
  return errorResponseSchema(codes);
}

export const spotAuthenticationErrors = {
  400: spotErrorResponseSchema(["invalid_request"]),
  401: {
    ...spotErrorResponseSchema([
      "authentication_required",
      "invalid_access_token",
    ]),
    headers: noStoreResponseHeaders(true),
  },
  409: spotErrorResponseSchema(["bootstrap_required"]),
  503: spotErrorResponseSchema([
    "authentication_unavailable",
    "spot_unavailable",
    "request_timeout",
  ]),
  500: spotErrorResponseSchema(["internal_error"]),
} as const;

export function hasRawHeader(
  request: FastifyRequest,
  expectedName: string,
): boolean {
  for (let index = 0; index < request.raw.rawHeaders.length; index += 2) {
    if (request.raw.rawHeaders[index]?.toLowerCase() === expectedName) {
      return true;
    }
  }
  return false;
}

export function assertNoRawBody(request: FastifyRequest): void {
  const contentLength = request.headers["content-length"];
  if (
    (contentLength !== undefined && contentLength !== "0") ||
    request.headers["transfer-encoding"] !== undefined
  ) {
    throw ApiError.invalidRequest();
  }
}

export const noBodyOrClientIdempotencyGuard: onRequestHookHandler = (
  request,
  _reply,
  done,
): void => {
  try {
    assertNoRawBody(request);
    if (hasRawHeader(request, "idempotency-key")) {
      throw ApiError.invalidRequest();
    }
  } catch (error) {
    done(error instanceof Error ? error : ApiError.invalidRequest());
    return;
  }
  done();
};

export const rejectClientIdempotencyGuard: onRequestHookHandler = (
  request,
  _reply,
  done,
): void => {
  if (hasRawHeader(request, "idempotency-key")) {
    done(ApiError.invalidRequest());
    return;
  }
  done();
};

export function mapCommonSpotError(error: unknown): never {
  if (
    error instanceof InvalidSpotRequestError ||
    error instanceof InvalidSpotPrincipalError
  ) {
    throw ApiError.invalidRequest();
  }
  if (error instanceof SpotWalletBindingRequiredError) {
    throw ApiError.walletBindingRequired();
  }
  if (error instanceof SpotVersionConflictError) {
    throw ApiError.versionConflict();
  }
  if (error instanceof SpotUnavailableError) {
    throw spotApiError(503, "spot_unavailable", "Spot is unavailable.");
  }
  throw error;
}
