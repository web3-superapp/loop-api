import { createHmac } from "node:crypto";

import { describe, expect, it, vi } from "vitest";

import {
  ControlPlaneUnavailableError,
  IssuanceQuotaExceededError,
  type ControlPlaneRepository,
} from "../src/database/control-plane-repository.js";
import {
  createStreamTokenService,
  InvalidStreamTokenRequestError,
  STREAM_TOKEN_CAPABILITIES,
  STREAM_TOKEN_TTL_SECONDS,
  StreamTokenIssuanceFailedError,
  StreamTokenQuotaExceededError,
  StreamTokenUnavailableError,
  type StreamTokenIssuancePolicy,
  type StreamTokenQuotaRepository,
} from "../src/features/communication/stream-token-service.js";
import {
  createUnavailableStreamTokenIssuer,
  type StreamTokenIssuer,
} from "../src/integrations/stream/token-issuer.js";

const loopUserId = "6d12a86e-4134-47e6-9312-c5ef75a30f55";
const streamUserId = "loop_6d12a86e413447e69312c5ef75a30f55";
const canonicalClientIp = "2001:db8::1";
const observedAt = new Date("2026-08-24T12:34:56.987Z");
const quotaHmacSecret = Uint8Array.from(
  { length: 32 },
  (_, index) => index + 1,
);
const providerToken = "t".repeat(64);
const policy = Object.freeze({
  policyVersion: "stream_tokens_v1",
  quotaByProduct: Object.freeze({
    chat: Object.freeze({
      user: Object.freeze({ capacity: 5, windowDurationSeconds: 60 }),
      ip: Object.freeze({ capacity: 20, windowDurationSeconds: 60 }),
    }),
    video: Object.freeze({
      user: Object.freeze({ capacity: 3, windowDurationSeconds: 120 }),
      ip: Object.freeze({ capacity: 12, windowDurationSeconds: 120 }),
    }),
  }),
}) satisfies StreamTokenIssuancePolicy;
const principal = Object.freeze({
  userId: loopUserId,
  privyUserId: "did:privy:verified-user",
  streamUserId,
});

function expectedSubjectHmac(
  capability: string,
  subjectKind: "user" | "ip",
  subject: string,
): string {
  return createHmac("sha256", quotaHmacSecret)
    .update("loop.stream-token-quota\0v1", "utf8")
    .update("\0", "utf8")
    .update(capability, "utf8")
    .update("\0", "utf8")
    .update(policy.policyVersion, "utf8")
    .update("\0", "utf8")
    .update(subjectKind, "utf8")
    .update("\0", "utf8")
    .update(subject, "utf8")
    .digest("hex");
}

function dependencies() {
  const consumeIssuanceQuota = vi.fn<
    ControlPlaneRepository["consumeIssuanceQuota"]
  >(() => Promise.resolve([]));
  const issueToken = vi.fn<StreamTokenIssuer["issueToken"]>(() =>
    Promise.resolve({ apiKey: "stream_public_key", token: providerToken }),
  );
  const quota = { consumeIssuanceQuota } satisfies StreamTokenQuotaRepository;
  const issuer = { issueToken } satisfies StreamTokenIssuer;
  const service = createStreamTokenService({
    issuer,
    quota,
    quotaHmacSecret,
    policy,
    now: () => observedAt,
  });

  return { consumeIssuanceQuota, issueToken, issuer, quota, service };
}

function request(product: "chat" | "video" = "chat") {
  return {
    principal,
    product,
    canonicalClientIp,
    signal: new AbortController().signal,
  } as const;
}

describe("Stream token service", () => {
  it("atomically reserves domain-separated user and IP quota before issuing Chat credentials", async () => {
    const inputs = dependencies();

    await expect(inputs.service.issueToken(request())).resolves.toEqual({
      api_key: "stream_public_key",
      token: providerToken,
      expires_at: "2026-08-24T13:34:56.000Z",
      user: { id: streamUserId },
    });

    expect(inputs.consumeIssuanceQuota).toHaveBeenCalledOnce();
    expect(inputs.consumeIssuanceQuota).toHaveBeenCalledWith({
      capability: STREAM_TOKEN_CAPABILITIES.chat,
      policyVersion: policy.policyVersion,
      buckets: [
        {
          subjectKind: "user",
          subjectHmac: expectedSubjectHmac(
            STREAM_TOKEN_CAPABILITIES.chat,
            "user",
            loopUserId,
          ),
          windowDurationSeconds: 60,
          capacity: 5,
        },
        {
          subjectKind: "ip",
          subjectHmac: expectedSubjectHmac(
            STREAM_TOKEN_CAPABILITIES.chat,
            "ip",
            canonicalClientIp,
          ),
          windowDurationSeconds: 60,
          capacity: 20,
        },
      ],
    });
    const quotaInput = inputs.consumeIssuanceQuota.mock.calls[0]?.[0];
    expect(JSON.stringify(quotaInput)).not.toContain(canonicalClientIp);
    expect(JSON.stringify(quotaInput)).not.toContain(loopUserId);
    expect(JSON.stringify(quotaInput)).not.toContain(providerToken);
    expect(
      inputs.consumeIssuanceQuota.mock.invocationCallOrder[0],
    ).toBeLessThan(inputs.issueToken.mock.invocationCallOrder[0] ?? 0);
  });

  it("passes an exact one-hour epoch window and only the server-derived principal to the issuer", async () => {
    const inputs = dependencies();
    const response = await inputs.service.issueToken(request());
    const issuedAtEpochSeconds = Math.floor(observedAt.getTime() / 1_000);

    expect(inputs.issueToken).toHaveBeenCalledWith(
      expect.objectContaining({
        product: "chat",
        streamUserId,
        issuedAtEpochSeconds,
        expiresAtEpochSeconds: issuedAtEpochSeconds + STREAM_TOKEN_TTL_SECONDS,
      }),
    );
    expect(inputs.issueToken.mock.calls[0]?.[0].signal).toBeInstanceOf(
      AbortSignal,
    );
    expect(
      (inputs.issueToken.mock.calls[0]?.[0].expiresAtEpochSeconds ?? 0) -
        (inputs.issueToken.mock.calls[0]?.[0].issuedAtEpochSeconds ?? 0),
    ).toBe(3_600);
    expect(Object.keys(response).sort()).toEqual([
      "api_key",
      "expires_at",
      "token",
      "user",
    ]);
    expect(Object.keys(response.user)).toEqual(["id"]);
    expect(Object.isFrozen(response)).toBe(true);
    expect(Object.isFrozen(response.user)).toBe(true);
  });

  it("uses an independent Video capability, quota policy, and HMAC domain", async () => {
    const inputs = dependencies();
    await inputs.service.issueToken(request("video"));

    expect(inputs.consumeIssuanceQuota).toHaveBeenCalledWith({
      capability: STREAM_TOKEN_CAPABILITIES.video,
      policyVersion: policy.policyVersion,
      buckets: [
        expect.objectContaining({
          subjectKind: "user",
          subjectHmac: expectedSubjectHmac(
            STREAM_TOKEN_CAPABILITIES.video,
            "user",
            loopUserId,
          ),
          capacity: 3,
          windowDurationSeconds: 120,
        }),
        expect.objectContaining({
          subjectKind: "ip",
          subjectHmac: expectedSubjectHmac(
            STREAM_TOKEN_CAPABILITIES.video,
            "ip",
            canonicalClientIp,
          ),
          capacity: 12,
          windowDurationSeconds: 120,
        }),
      ],
    });
    const videoUserHmac =
      inputs.consumeIssuanceQuota.mock.calls[0]?.[0].buckets[0]?.subjectHmac;
    expect(videoUserHmac).not.toBe(
      expectedSubjectHmac(STREAM_TOKEN_CAPABILITIES.chat, "user", loopUserId),
    );
    expect(inputs.issueToken).toHaveBeenCalledWith(
      expect.objectContaining({ product: "video" }),
    );
  });

  it("propagates a pre-existing abort before reserving quota", async () => {
    const inputs = dependencies();
    const controller = new AbortController();
    const abortReason = new Error("request-aborted-before-stream-quota");
    controller.abort(abortReason);

    await expect(
      inputs.service.issueToken({
        ...request(),
        signal: controller.signal,
      }),
    ).rejects.toBe(abortReason);
    expect(inputs.consumeIssuanceQuota).not.toHaveBeenCalled();
    expect(inputs.issueToken).not.toHaveBeenCalled();
  });

  it("does not issue after an abort that follows a successful quota reservation", async () => {
    const inputs = dependencies();
    const controller = new AbortController();
    const abortReason = new Error("request-aborted-after-stream-quota");
    inputs.consumeIssuanceQuota.mockImplementationOnce(() => {
      controller.abort(abortReason);
      return Promise.resolve([]);
    });

    await expect(
      inputs.service.issueToken({
        ...request(),
        signal: controller.signal,
      }),
    ).rejects.toBe(abortReason);
    expect(inputs.consumeIssuanceQuota).toHaveBeenCalledOnce();
    expect(inputs.issueToken).not.toHaveBeenCalled();
  });

  it("propagates an abort that occurs during issuer work", async () => {
    const inputs = dependencies();
    const controller = new AbortController();
    const abortReason = new Error("request-aborted-during-stream-issuer");
    inputs.issueToken.mockImplementationOnce(() => {
      controller.abort(abortReason);
      return Promise.reject(new Error("issuer-operation-interrupted"));
    });

    await expect(
      inputs.service.issueToken({
        ...request(),
        signal: controller.signal,
      }),
    ).rejects.toBe(abortReason);
    expect(inputs.consumeIssuanceQuota).toHaveBeenCalledOnce();
    expect(inputs.issueToken).toHaveBeenCalledOnce();
  });

  it("does not return an issued token when the request aborts as issuer work resolves", async () => {
    const inputs = dependencies();
    const controller = new AbortController();
    const abortReason = new Error("request-aborted-as-stream-issuer-resolved");
    inputs.issueToken.mockImplementationOnce(() => {
      controller.abort(abortReason);
      return Promise.resolve({
        apiKey: "stream_public_key",
        token: providerToken,
      });
    });

    await expect(
      inputs.service.issueToken({
        ...request(),
        signal: controller.signal,
      }),
    ).rejects.toBe(abortReason);
    expect(inputs.consumeIssuanceQuota).toHaveBeenCalledOnce();
    expect(inputs.issueToken).toHaveBeenCalledOnce();
  });

  it("maps quota exhaustion to a stable service error without calling the issuer", async () => {
    const inputs = dependencies();
    inputs.consumeIssuanceQuota.mockRejectedValueOnce(
      new IssuanceQuotaExceededError(),
    );

    await expect(inputs.service.issueToken(request())).rejects.toEqual(
      expect.objectContaining({
        name: "StreamTokenQuotaExceededError",
        code: "stream_token_quota_exceeded",
        message: "Stream token issuance quota exceeded",
      }),
    );
    await expect(
      Promise.reject(new StreamTokenQuotaExceededError()),
    ).rejects.toHaveProperty("code", "stream_token_quota_exceeded");
    expect(inputs.issueToken).not.toHaveBeenCalled();
  });

  it.each([
    [
      "control plane unavailable",
      new ControlPlaneUnavailableError(),
      StreamTokenUnavailableError,
      "stream_token_unavailable",
    ],
    [
      "unexpected control-plane failure",
      new Error("database-secret-detail"),
      StreamTokenIssuanceFailedError,
      "stream_token_issuance_failed",
    ],
  ])("sanitizes a %s", async (_name, failure, ExpectedError, expectedCode) => {
    const inputs = dependencies();
    inputs.consumeIssuanceQuota.mockRejectedValueOnce(failure);

    const result = inputs.service.issueToken(request());
    await expect(result).rejects.toBeInstanceOf(ExpectedError);
    await expect(result).rejects.not.toThrow("database-secret-detail");
    expect(await result.catch((error: unknown) => error)).toHaveProperty(
      "code",
      expectedCode,
    );
    expect(inputs.issueToken).not.toHaveBeenCalled();
  });

  it("maps an unavailable issuer to a stable unavailable error", async () => {
    const inputs = dependencies();
    const service = createStreamTokenService({
      issuer: createUnavailableStreamTokenIssuer(),
      quota: inputs.quota,
      quotaHmacSecret,
      policy,
      now: () => observedAt,
    });

    await expect(service.issueToken(request())).rejects.toBeInstanceOf(
      StreamTokenUnavailableError,
    );
  });

  it("sanitizes unexpected issuer failures", async () => {
    const inputs = dependencies();
    inputs.issueToken.mockRejectedValueOnce(
      new Error("provider-secret-response"),
    );

    const result = inputs.service.issueToken(request());
    await expect(result).rejects.toBeInstanceOf(StreamTokenIssuanceFailedError);
    await expect(result).rejects.not.toThrow("provider-secret-response");
  });

  it.each([
    ["extra field", { apiKey: "key", token: providerToken, secret: "no" }],
    ["empty API key", { apiKey: "", token: providerToken }],
    ["short token", { apiKey: "key", token: "short" }],
    ["non-object", "not-an-issued-token"],
  ])("rejects a malformed issuer result with %s", async (_name, result) => {
    const inputs = dependencies();
    inputs.issueToken.mockResolvedValueOnce(
      result as Awaited<ReturnType<StreamTokenIssuer["issueToken"]>>,
    );

    await expect(inputs.service.issueToken(request())).rejects.toBeInstanceOf(
      StreamTokenIssuanceFailedError,
    );
  });

  it.each([
    ["non-canonical IPv6", "2001:0DB8:0:0:0:0:0:1", streamUserId],
    ["invalid IP", "not-an-ip", streamUserId],
    ["forged Stream subject", canonicalClientIp, "loop_forged_subject"],
  ])(
    "rejects %s before quota or issuer work",
    async (_name, clientIp, principalStreamUserId) => {
      const inputs = dependencies();

      await expect(
        inputs.service.issueToken({
          ...request(),
          canonicalClientIp: clientIp,
          principal: { ...principal, streamUserId: principalStreamUserId },
        }),
      ).rejects.toBeInstanceOf(InvalidStreamTokenRequestError);
      expect(inputs.consumeIssuanceQuota).not.toHaveBeenCalled();
      expect(inputs.issueToken).not.toHaveBeenCalled();
    },
  );

  it("rejects an unknown product before quota or issuer work", async () => {
    const inputs = dependencies();

    await expect(
      inputs.service.issueToken({
        ...request(),
        product: "unknown" as "chat",
      }),
    ).rejects.toBeInstanceOf(InvalidStreamTokenRequestError);
    expect(inputs.consumeIssuanceQuota).not.toHaveBeenCalled();
    expect(inputs.issueToken).not.toHaveBeenCalled();
  });

  it("copies policy and HMAC key material at construction", async () => {
    const mutableSecret = Uint8Array.from(quotaHmacSecret);
    const mutablePolicy = {
      policyVersion: policy.policyVersion,
      quotaByProduct: {
        chat: {
          user: { capacity: 5, windowDurationSeconds: 60 },
          ip: { capacity: 20, windowDurationSeconds: 60 },
        },
        video: {
          user: { capacity: 3, windowDurationSeconds: 120 },
          ip: { capacity: 12, windowDurationSeconds: 120 },
        },
      },
    } satisfies StreamTokenIssuancePolicy;
    const inputs = dependencies();
    const service = createStreamTokenService({
      issuer: inputs.issuer,
      quota: inputs.quota,
      quotaHmacSecret: mutableSecret,
      policy: mutablePolicy,
      now: () => observedAt,
    });
    mutableSecret.fill(0);
    mutablePolicy.quotaByProduct.chat.user.capacity = 99;

    await service.issueToken(request());

    expect(inputs.consumeIssuanceQuota).toHaveBeenCalledWith(
      expect.objectContaining({
        buckets: [
          expect.objectContaining({
            capacity: 5,
            subjectHmac: expectedSubjectHmac(
              STREAM_TOKEN_CAPABILITIES.chat,
              "user",
              loopUserId,
            ),
          }),
          expect.any(Object),
        ],
      }),
    );
  });
});
