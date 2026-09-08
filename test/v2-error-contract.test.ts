import { describe, expect, it } from "vitest";

import { ApiError } from "../src/core/http/api-error.js";
import {
  projectV2Error,
  V2ApiError,
  v2ErrorCatalog,
  v2ErrorCategories,
  v2ErrorCodes,
  v2ErrorResponseSchema,
} from "../src/core/http/v2-error.js";

const correlationId = "00000000-0000-4000-8000-000000000000";

describe("V2 error trust boundary", () => {
  it.each([401, 403, 404, 409, 422, 429, 503])(
    "does not trust an unknown error's %s status code",
    (statusCode) => {
      const projection = projectV2Error({ statusCode }, correlationId);

      expect(projection).toEqual({
        statusCode: 500,
        includeBearerChallenge: false,
        response: {
          code: "INTERNAL_ERROR",
          category: "internal",
          retryable: false,
          userMessageKey: "errors.internal",
          correlationId,
          detailsSafe: null,
          providerReferenceSafe: null,
        },
      });
    },
  );

  it("accepts only allowlisted Fastify validation codes as client input", () => {
    expect(
      projectV2Error(
        { code: "FST_ERR_VALIDATION", statusCode: 503 },
        correlationId,
      ),
    ).toMatchObject({
      statusCode: 400,
      includeBearerChallenge: false,
      response: { code: "INVALID_REQUEST" },
    });

    expect(
      projectV2Error(
        { code: "UNTRUSTED_PROVIDER_ERROR", statusCode: 400 },
        correlationId,
      ),
    ).toMatchObject({
      statusCode: 500,
      includeBearerChallenge: false,
      response: { code: "INTERNAL_ERROR" },
    });
  });

  it("maps only the explicit Fastify handler timeout to a retryable timeout", () => {
    expect(
      projectV2Error({ code: "FST_ERR_HANDLER_TIMEOUT" }, correlationId),
    ).toMatchObject({
      statusCode: 503,
      includeBearerChallenge: false,
      response: { code: "REQUEST_TIMEOUT", retryable: true },
    });
  });
});

describe("V2 error code catalog", () => {
  const expectedCatalog = {
    ACCOUNT_BOOTSTRAP_REQUIRED: [
      409,
      "authentication",
      false,
      "errors.account.bootstrapRequired",
      false,
    ],
    ALIAS_BLOCKED: [422, "validation", false, "errors.alias.blocked", false],
    ALIAS_RESERVED: [422, "validation", false, "errors.alias.reserved", false],
    AUTH_INVALID: [401, "authentication", false, "errors.auth.invalid", true],
    AUTH_REQUIRED: [401, "authentication", false, "errors.auth.required", true],
    AUTH_STEP_UP_REQUIRED: [
      403,
      "authentication",
      false,
      "errors.auth.stepUpRequired",
      false,
    ],
    CAPABILITY_UNAVAILABLE: [
      503,
      "availability",
      true,
      "errors.capability.unavailable",
      false,
    ],
    CHAIN_MISMATCH: [422, "validation", false, "errors.chain.mismatch", false],
    DATA_STALE: [409, "stale", false, "errors.data.stale", false],
    IDEMPOTENCY_CONFLICT: [
      409,
      "conflict",
      false,
      "errors.idempotency.conflict",
      false,
    ],
    INDEXING_DELAYED: [
      503,
      "availability",
      true,
      "errors.indexing.delayed",
      false,
    ],
    INSUFFICIENT_BALANCE: [
      409,
      "conflict",
      false,
      "errors.balance.insufficient",
      false,
    ],
    INTERNAL_ERROR: [500, "internal", false, "errors.internal", false],
    INVALID_REQUEST: [
      400,
      "validation",
      false,
      "errors.request.invalid",
      false,
    ],
    MAINTENANCE: [
      503,
      "availability",
      true,
      "errors.service.maintenance",
      false,
    ],
    NOT_FOUND: [404, "validation", false, "errors.resource.notFound", false],
    PERMISSION_DENIED: [
      403,
      "authorization",
      false,
      "errors.permission.denied",
      false,
    ],
    POLICY_BLOCKED: [
      403,
      "authorization",
      false,
      "errors.policy.blocked",
      false,
    ],
    PROFILE_ACTIVATION_REQUIRED: [
      409,
      "conflict",
      false,
      "errors.profile.activationRequired",
      false,
    ],
    PROVIDER_DISCONNECTED: [
      503,
      "availability",
      true,
      "errors.provider.disconnected",
      false,
    ],
    QUOTE_EXPIRED: [409, "stale", false, "errors.quote.expired", false],
    RATE_LIMITED: [429, "rateLimit", true, "errors.rateLimit.exceeded", false],
    REGION_BLOCKED: [
      403,
      "authorization",
      false,
      "errors.region.blocked",
      false,
    ],
    REQUEST_TIMEOUT: [
      503,
      "availability",
      true,
      "errors.request.timeout",
      false,
    ],
    SESSION_NOT_FOUND: [
      404,
      "validation",
      false,
      "errors.session.notFound",
      false,
    ],
    SIMULATION_FAILED: [
      409,
      "conflict",
      false,
      "errors.simulation.failed",
      false,
    ],
    SUBMISSION_UNKNOWN: [
      409,
      "conflict",
      false,
      "errors.submission.unknown",
      false,
    ],
    VALIDATION_FAILED: [
      422,
      "validation",
      false,
      "errors.validation.failed",
      false,
    ],
    VERSION_CONFLICT: [
      409,
      "conflict",
      false,
      "errors.version.conflict",
      false,
    ],
  } as const;

  it("matches the frozen code table exactly", () => {
    expect(
      Object.fromEntries(
        Object.entries(v2ErrorCatalog).map(([code, entry]) => [
          code,
          [
            entry.statusCode,
            entry.category,
            entry.retryable,
            entry.userMessageKey,
            entry.includeBearerChallenge,
          ],
        ]),
      ),
    ).toEqual(expectedCatalog);
    expect(v2ErrorCodes).toEqual(Object.keys(expectedCatalog).sort());
    expect(v2ErrorCodes).toHaveLength(29);
  });

  it("keeps the category enum at exactly eight values", () => {
    expect([...v2ErrorCategories]).toEqual([
      "authentication",
      "authorization",
      "availability",
      "conflict",
      "internal",
      "rateLimit",
      "stale",
      "validation",
    ]);
    for (const entry of Object.values(v2ErrorCatalog)) {
      expect(v2ErrorCategories).toContain(entry.category);
      expect(entry.userMessageKey).toMatch(
        /^errors\.[a-z][A-Za-z]*(?:\.[A-Za-z]+)?$/,
      );
    }
    expect(
      v2ErrorResponseSchema(["NOT_FOUND"]).properties.category.enum,
    ).toEqual([...v2ErrorCategories]);
  });

  it("projects every catalog code through the seven-field envelope", () => {
    for (const code of v2ErrorCodes) {
      const entry = v2ErrorCatalog[code];
      const projection = projectV2Error(
        V2ApiError.fromCode(code),
        correlationId,
      );

      expect(projection).toEqual({
        statusCode: entry.statusCode,
        includeBearerChallenge: entry.includeBearerChallenge,
        response: {
          code,
          category: entry.category,
          retryable: entry.retryable,
          userMessageKey: entry.userMessageKey,
          correlationId,
          detailsSafe: null,
          providerReferenceSafe: null,
        },
      });
      expect(Object.keys(projection.response)).toEqual([
        "code",
        "category",
        "retryable",
        "userMessageKey",
        "correlationId",
        "detailsSafe",
        "providerReferenceSafe",
      ]);
    }
  });

  it("maps frozen V1 errors onto catalog entries with fixed localization keys", () => {
    const stale = projectV2Error(
      new ApiError({
        statusCode: 409,
        code: "perp_intent_expired",
        safeMessage: "expired",
      }),
      correlationId,
    );
    const blocked = projectV2Error(
      new ApiError({
        statusCode: 403,
        code: "wallet_binding_required",
        safeMessage: "binding",
      }),
      correlationId,
    );
    const unauthenticated = projectV2Error(
      ApiError.authenticationRequired(),
      correlationId,
    );

    expect(stale).toMatchObject({
      statusCode: 409,
      response: { code: "DATA_STALE", userMessageKey: "errors.data.stale" },
    });
    expect(blocked).toMatchObject({
      statusCode: 403,
      response: {
        code: "POLICY_BLOCKED",
        userMessageKey: "errors.policy.blocked",
      },
    });
    expect(unauthenticated).toMatchObject({
      statusCode: 401,
      includeBearerChallenge: true,
      response: {
        code: "AUTH_REQUIRED",
        userMessageKey: "errors.auth.required",
      },
    });
  });
});
