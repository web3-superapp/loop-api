import { noStoreResponseHeaders } from "../../core/http/schemas.js";

/**
 * Operator console contract (Decision 0102). The console is the management
 * shell of this API: every rule is still enforced here and every write lands
 * in the database with an audit row. Its error body is the same seven-field
 * envelope as `/v2` (00 §4.6), with the console's own codes.
 */

export const adminApiPrefix = "/admin/v1" as const;
export const adminSessionCookieName = "loop_admin_session" as const;
/** 12 hours. */
export const adminSessionTtlSeconds = 12 * 60 * 60;
export const adminLoginMaximumFailures = 5;
/** 15 minutes. */
export const adminLoginLockSeconds = 15 * 60;

export const adminErrorCategories = Object.freeze([
  "authentication",
  "availability",
  "conflict",
  "internal",
  "rateLimit",
  "validation",
] as const);
export type AdminErrorCategory = (typeof adminErrorCategories)[number];

export type AdminErrorStatusCode =
  400 | 401 | 404 | 409 | 422 | 423 | 429 | 500 | 503;

interface AdminErrorCatalogEntry {
  readonly statusCode: AdminErrorStatusCode;
  readonly category: AdminErrorCategory;
  readonly retryable: boolean;
  readonly userMessageKey: string;
}

export const adminErrorCatalog = Object.freeze({
  /** No session cookie, or one that is expired, forged, or logged out. */
  ADMIN_SESSION_REQUIRED: {
    statusCode: 401,
    category: "authentication",
    retryable: false,
    userMessageKey: "errors.admin.sessionRequired",
  },
  /** Wrong username or password; one failure counted. */
  ADMIN_LOGIN_INVALID: {
    statusCode: 401,
    category: "authentication",
    retryable: false,
    userMessageKey: "errors.admin.loginInvalid",
  },
  /** Five failures in a row: every login refused for 15 minutes. */
  ADMIN_LOGIN_LOCKED: {
    statusCode: 423,
    category: "rateLimit",
    retryable: true,
    userMessageKey: "errors.admin.loginLocked",
  },
  /**
   * Decision 0105: another login is being verified right now; only one runs
   * at a time. `detailsSafe.retryAfterSeconds` and `Retry-After` say when to
   * try again. Not counted as a failure.
   */
  ADMIN_LOGIN_BUSY: {
    statusCode: 429,
    category: "rateLimit",
    retryable: true,
    userMessageKey: "errors.admin.loginBusy",
  },
  /** Optimistic concurrency (`updatedAt`) or a state transition refused. */
  ADMIN_CONFLICT: {
    statusCode: 409,
    category: "conflict",
    retryable: false,
    userMessageKey: "errors.admin.conflict",
  },
  INVALID_REQUEST: {
    statusCode: 400,
    category: "validation",
    retryable: false,
    userMessageKey: "errors.request.invalid",
  },
  VALIDATION_FAILED: {
    statusCode: 422,
    category: "validation",
    retryable: false,
    userMessageKey: "errors.validation.failed",
  },
  NOT_FOUND: {
    statusCode: 404,
    category: "validation",
    retryable: false,
    userMessageKey: "errors.resource.notFound",
  },
  CAPABILITY_UNAVAILABLE: {
    statusCode: 503,
    category: "availability",
    retryable: true,
    userMessageKey: "errors.capability.unavailable",
  },
  REQUEST_TIMEOUT: {
    statusCode: 503,
    category: "availability",
    retryable: true,
    userMessageKey: "errors.request.timeout",
  },
  INTERNAL_ERROR: {
    statusCode: 500,
    category: "internal",
    retryable: false,
    userMessageKey: "errors.internal",
  },
} as const satisfies Readonly<Record<string, AdminErrorCatalogEntry>>);

export type AdminErrorCode = keyof typeof adminErrorCatalog;
export const adminErrorCodes = Object.freeze(
  Object.keys(adminErrorCatalog).sort() as AdminErrorCode[],
);

export type AdminErrorDetailsSafe = Readonly<
  Record<string, string | number | boolean | null>
>;

export class AdminApiError extends Error {
  readonly code: AdminErrorCode;
  readonly statusCode: AdminErrorStatusCode;
  readonly detailsSafe: AdminErrorDetailsSafe | null;

  constructor(
    code: AdminErrorCode,
    detailsSafe: AdminErrorDetailsSafe | null = null,
  ) {
    super(adminErrorCatalog[code].userMessageKey);
    this.name = "AdminApiError";
    this.code = code;
    this.statusCode = adminErrorCatalog[code].statusCode;
    this.detailsSafe =
      detailsSafe === null ? null : Object.freeze({ ...detailsSafe });
  }
}

export interface AdminErrorResponse {
  readonly code: AdminErrorCode;
  readonly category: AdminErrorCategory;
  readonly retryable: boolean;
  readonly userMessageKey: string;
  readonly correlationId: string;
  readonly detailsSafe: AdminErrorDetailsSafe | null;
  readonly providerReferenceSafe: null;
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

export function projectAdminError(
  error: unknown,
  correlationId: string,
): {
  readonly statusCode: AdminErrorStatusCode;
  readonly response: AdminErrorResponse;
} {
  let code: AdminErrorCode = "INTERNAL_ERROR";
  let detailsSafe: AdminErrorDetailsSafe | null = null;
  if (error instanceof AdminApiError) {
    code = error.code;
    detailsSafe = error.detailsSafe;
  } else if (typeof error === "object" && error !== null && "code" in error) {
    const raw = (error as { readonly code?: unknown }).code;
    if (raw === "FST_ERR_HANDLER_TIMEOUT") {
      code = "REQUEST_TIMEOUT";
    } else if (typeof raw === "string" && fastifyInvalidRequestCodes.has(raw)) {
      code = "INVALID_REQUEST";
    }
  }
  const entry = adminErrorCatalog[code];
  return Object.freeze({
    statusCode: entry.statusCode,
    response: Object.freeze({
      code,
      category: entry.category,
      retryable: entry.retryable,
      userMessageKey: entry.userMessageKey,
      correlationId,
      detailsSafe,
      providerReferenceSafe: null,
    }),
  });
}

export function isAdminRequestPath(rawUrl: string | undefined): boolean {
  if (rawUrl === undefined) {
    return false;
  }
  const queryIndex = rawUrl.indexOf("?");
  const path = queryIndex === -1 ? rawUrl : rawUrl.slice(0, queryIndex);
  return path === adminApiPrefix || path.startsWith(`${adminApiPrefix}/`);
}

export function adminErrorResponseSchema(codes: readonly AdminErrorCode[]) {
  return {
    type: "object",
    headers: noStoreResponseHeaders(),
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
      code: { type: "string", enum: [...codes] },
      category: { type: "string", enum: [...adminErrorCategories] },
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
      providerReferenceSafe: { type: "null" },
    },
  } as const;
}

/** Machine reason codes carried in `detailsSafe.reasonCode`. */
export const adminReasonCodes = Object.freeze({
  updatedAtMismatch: "ADMIN_UPDATED_AT_MISMATCH",
  communityNotVerified: "ADMIN_COMMUNITY_NOT_VERIFIED",
  communityNotFound: "ADMIN_COMMUNITY_NOT_FOUND",
  communityAlreadyVerified: "ADMIN_COMMUNITY_ALREADY_VERIFIED",
  promotionInvalid: "ADMIN_PROMOTION_INVALID",
  formulaExists: "ADMIN_FORMULA_VERSION_EXISTS",
  formulaNotFound: "ADMIN_FORMULA_VERSION_NOT_FOUND",
  formulaState: "ADMIN_FORMULA_STATE_INVALID",
  formulaInvalid: "ADMIN_FORMULA_PARAMETERS_INVALID",
  formulaWeightOutOfRange: "ADMIN_FORMULA_COMMUNITY_WEIGHT_OUT_OF_RANGE",
  formulaWeightUnbound: "ADMIN_FORMULA_COMMUNITY_ASSET_NOT_BOUND",
  formulaWeightConflict: "ADMIN_FORMULA_COMMUNITY_WEIGHT_CONFLICT",
  formulaApproveProduction: "MINING_APPROVE_FORBIDDEN_IN_PRODUCTION",
  memeTokenNotFound: "ADMIN_MEME_TOKEN_NOT_FOUND",
  memeExecutorDisabled: "MEME_EXECUTOR_DISABLED",
  memeContractNotConfigured: "MEME_CONTRACT_NOT_CONFIGURED",
  memeTokenNotOnChain: "MEME_TOKEN_NOT_ON_CHAIN",
  memeMainnetSigningClosed: "MEME_MAINNET_SIGNING_CLOSED",
  memeRpcNotConfigured: "MEME_CHAIN_RPC_NOT_CONFIGURED",
  memePauseState: "MEME_PAUSE_STATE_INVALID",
  memePauseSimulationReverted: "MEME_PAUSE_SIMULATION_REVERTED",
  memePauseBroadcastFailed: "MEME_PAUSE_BROADCAST_FAILED",
  /** Decision 0105: MEME_OPERATOR_PRIVATE_KEY is not configured. */
  memeOperatorKeyMissing: "MEME_OPERATOR_KEY_MISSING",
  /** Decision 0105: a pause/unpause of this token is still unconfirmed. */
  memePausePending: "MEME_PAUSE_PENDING",
  /** Decision 0105: the intent audit row could not be written; nothing ran. */
  auditUnavailable: "ADMIN_AUDIT_UNAVAILABLE",
  databaseUnavailable: "ADMIN_DATABASE_UNAVAILABLE",
  communityReviewUnavailable: "COMMUNITY_REVIEW_UNAVAILABLE",
} as const);
