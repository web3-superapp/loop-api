import { createHmac } from "node:crypto";

import { describe, expect, it } from "vitest";

import {
  createStreamTokenIssuer,
  type IssueStreamProviderTokenInput,
  type StreamTokenProduct,
} from "../src/integrations/stream/token-issuer.js";

const apiKey = "stream_test_api_key";
const apiSecret = "stream_test_api_secret";
const streamUserId = "loop_6d12a86e413447e69312c5ef75a30f55";
const issuedAtEpochSeconds = 1_788_000_000;
const expiresAtEpochSeconds = issuedAtEpochSeconds + 3_600;

function request(
  product: StreamTokenProduct,
  overrides: Partial<IssueStreamProviderTokenInput> = {},
): IssueStreamProviderTokenInput {
  return {
    product,
    streamUserId,
    issuedAtEpochSeconds,
    expiresAtEpochSeconds,
    signal: new AbortController().signal,
    ...overrides,
  };
}

function decodeAndVerify(token: string): {
  readonly header: Record<string, unknown>;
  readonly payload: Record<string, unknown>;
} {
  const segments = token.split(".");
  expect(segments).toHaveLength(3);
  const [encodedHeader, encodedPayload, signature] = segments;
  if (
    encodedHeader === undefined ||
    encodedPayload === undefined ||
    signature === undefined
  ) {
    throw new Error("Expected a three-segment Stream JWT");
  }

  expect(signature).toBe(
    createHmac("sha256", apiSecret)
      .update(`${encodedHeader}.${encodedPayload}`, "utf8")
      .digest("base64url"),
  );

  return {
    header: JSON.parse(
      Buffer.from(encodedHeader, "base64url").toString("utf8"),
    ) as Record<string, unknown>,
    payload: JSON.parse(
      Buffer.from(encodedPayload, "base64url").toString("utf8"),
    ) as Record<string, unknown>,
  };
}

describe("official Stream token issuer", () => {
  it("uses the same narrowly scoped one-hour user token for Chat and Video", async () => {
    const issuer = createStreamTokenIssuer({ apiKey, apiSecret });

    const chat = await issuer.issueToken(request("chat"));
    const video = await issuer.issueToken(request("video"));

    expect(chat.apiKey).toBe(apiKey);
    expect(video.apiKey).toBe(apiKey);
    expect(video.token).toBe(chat.token);
    expect(JSON.stringify({ chat, video })).not.toContain(apiSecret);
    const decoded = decodeAndVerify(chat.token);
    expect(decoded.header).toEqual({ alg: "HS256", typ: "JWT" });
    expect(decoded.payload).toEqual({
      user_id: streamUserId,
      iat: issuedAtEpochSeconds,
      exp: expiresAtEpochSeconds,
    });
  });

  it.each([
    ["epoch-zero iat", 0, 3_600],
    ["fractional iat", issuedAtEpochSeconds + 0.5, expiresAtEpochSeconds],
    ["fractional exp", issuedAtEpochSeconds, expiresAtEpochSeconds + 0.5],
    ["non-one-hour ttl", issuedAtEpochSeconds, expiresAtEpochSeconds - 1],
  ] as const)("rejects %s before signing", async (_name, iat, exp) => {
    const issuer = createStreamTokenIssuer({ apiKey, apiSecret });

    await expect(
      issuer.issueToken(
        request("chat", {
          issuedAtEpochSeconds: iat,
          expiresAtEpochSeconds: exp,
        }),
      ),
    ).rejects.toThrow("Invalid Stream token issuance input");
  });

  it.each([
    ["unsupported product", { product: "calls" as StreamTokenProduct }],
    ["non-LOOP subject", { streamUserId: "external_user" }],
  ] as const)("rejects %s before signing", async (_name, overrides) => {
    const issuer = createStreamTokenIssuer({ apiKey, apiSecret });

    await expect(issuer.issueToken(request("chat", overrides))).rejects.toThrow(
      "Invalid Stream token issuance input",
    );
  });

  it("fails closed when the request is already aborted", async () => {
    const issuer = createStreamTokenIssuer({ apiKey, apiSecret });
    const controller = new AbortController();
    const abortReason = new Error("request-aborted-before-stream-signing");
    controller.abort(abortReason);

    await expect(
      issuer.issueToken(request("video", { signal: controller.signal })),
    ).rejects.toBe(abortReason);
  });
});
