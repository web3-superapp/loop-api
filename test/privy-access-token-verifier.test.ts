import { generateKeyPairSync, sign, type KeyObject } from "node:crypto";

import { describe, expect, it } from "vitest";

import {
  createPrivyAccessTokenVerifier,
  createPrivyAccessTokenVerifierWithClient,
  InvalidAccessTokenError,
} from "../src/integrations/privy/access-token-verifier.js";
import { createPrivyServerClient } from "../src/integrations/privy/client.js";

const appId = "app_test_privy";
const keyPair = generateKeyPairSync("ec", { namedCurve: "P-256" });
const verificationKey = keyPair.publicKey
  .export({ format: "pem", type: "spki" })
  .toString();

interface TokenClaims {
  readonly iss?: string | undefined;
  readonly aud?: string | undefined;
  readonly iat?: number | undefined;
  readonly exp?: number | undefined;
  readonly sid?: string | undefined;
  readonly sub?: string | undefined;
}

function encodeJson(value: object): string {
  return Buffer.from(JSON.stringify(value)).toString("base64url");
}

function createToken(
  claims: TokenClaims = {},
  privateKey: KeyObject = keyPair.privateKey,
): string {
  const now = Math.floor(Date.now() / 1_000);
  const header = encodeJson({ alg: "ES256", typ: "JWT" });
  const payload = encodeJson({
    iss: "privy.io",
    aud: appId,
    iat: now,
    exp: now + 300,
    sid: "session_test",
    sub: "did:privy:test-user",
    ...claims,
  });
  const signingInput = `${header}.${payload}`;
  const signature = sign("sha256", Buffer.from(signingInput), {
    key: privateKey,
    dsaEncoding: "ieee-p1363",
  }).toString("base64url");

  return `${signingInput}.${signature}`;
}

function verifier() {
  return createPrivyAccessTokenVerifier({
    appId,
    appSecret: "synthetic-test-secret",
    jwtVerificationKey: verificationKey,
  });
}

describe("Privy access-token verifier", () => {
  it("returns only the trusted Privy user ID for a valid token", async () => {
    await expect(verifier().verifyAccessToken(createToken())).resolves.toEqual({
      privyUserId: "did:privy:test-user",
    });
  });

  it.each([
    ["wrong issuer", { iss: "example.com" }],
    ["wrong audience", { aud: "app_other" }],
    ["expired token", { exp: 1 }],
    ["missing issued at", { iat: undefined }],
    ["missing expiration", { exp: undefined }],
    ["missing session", { sid: undefined }],
    ["missing user", { sub: undefined }],
    ["whitespace user", { sub: " did:privy:test-user " }],
    ["oversized user", { sub: `did:privy:${"x".repeat(256)}` }],
  ] as const)("rejects a token with %s", async (_name, claims) => {
    await expect(
      verifier().verifyAccessToken(createToken(claims)),
    ).rejects.toBeInstanceOf(InvalidAccessTokenError);
  });

  it("rejects a token signed by another key", async () => {
    const otherKey = generateKeyPairSync("ec", { namedCurve: "P-256" });

    await expect(
      verifier().verifyAccessToken(createToken({}, otherKey.privateKey)),
    ).rejects.toBeInstanceOf(InvalidAccessTokenError);
  });

  it("reuses one verifier across repeated token checks", async () => {
    const sharedVerifier = verifier();

    await expect(
      Promise.all([
        sharedVerifier.verifyAccessToken(createToken()),
        sharedVerifier.verifyAccessToken(createToken()),
      ]),
    ).resolves.toHaveLength(2);
  });

  it("accepts the process-scoped Privy client used by other server adapters", async () => {
    const options = {
      appId,
      appSecret: "synthetic-test-secret",
      jwtVerificationKey: verificationKey,
    };
    const client = createPrivyServerClient(options);

    await expect(
      createPrivyAccessTokenVerifierWithClient(
        options,
        client,
      ).verifyAccessToken(createToken()),
    ).resolves.toEqual({ privyUserId: "did:privy:test-user" });
  });
});
