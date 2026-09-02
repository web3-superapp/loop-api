import { describe, expect, it } from "vitest";

import { projectV2Error } from "../src/core/http/v2-error.js";

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
