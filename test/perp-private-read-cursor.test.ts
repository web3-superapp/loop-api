import { createHmac } from "node:crypto";

import { describe, expect, it } from "vitest";

import {
  createPerpPrivateReadCursorCodec,
  InvalidPerpReadCursorError,
  PERP_PRIVATE_READ_CURSOR_DEFAULT_TTL_SECONDS,
  PERP_PRIVATE_READ_CURSOR_MAX_LIMIT,
  PERP_PRIVATE_READ_CURSOR_MAX_PROVIDER_STATE_LENGTH,
  PERP_PRIVATE_READ_CURSOR_MIN_LIMIT,
  type PerpPrivateReadCursorScope,
} from "../src/features/perp/private-read-cursor.js";
import {
  createUnavailablePerpWalletBindingResolver,
  WalletBindingRequiredError,
  WalletBindingResolutionUnavailableError,
} from "../src/features/perp/wallet-binding-resolver.js";
import {
  createUnavailableHyperliquidPrivateReader,
  HyperliquidPrivateReaderUnavailableError,
  RetryableHyperliquidReadError,
} from "../src/integrations/hyperliquid/private-reader.js";

const secret = Buffer.from(
  "018ad7733fc31db538419fd44cf4b27fc68c09f626fc7a2d6be6a7de17c26c59",
  "hex",
);
const observedAt = new Date("2026-08-24T12:34:56.987Z");
const ownerUserId = "6d12a86e-4134-47e6-9312-c5ef75a30f55";
const otherOwnerUserId = "b0825ec2-a585-45c8-9e9f-5279c69d49b3";
const accountAddress = "0x11111111111111111111111111111111111111aa";
const mixedCaseAccountAddress = "0x11111111111111111111111111111111111111AA";
const otherAccountAddress = "0x22222222222222222222222222222222222222bb";
const bindingVersion = "7";
const providerCursorState = Buffer.from("provider-page-state", "utf8").toString(
  "base64url",
);

const baseContext = Object.freeze({
  ownerUserId,
  accountAddress,
  bindingVersion,
  scope: "positions" as const,
});

function codec(now: () => Date = () => observedAt) {
  return createPerpPrivateReadCursorCodec({ secret, now });
}

function encodeInput(
  overrides: Partial<Parameters<ReturnType<typeof codec>["encode"]>[0]> = {},
) {
  return {
    ...baseContext,
    limit: 50,
    providerCursorState,
    ...overrides,
  };
}

function decodeInput(
  cursor: string,
  overrides: Partial<Parameters<ReturnType<typeof codec>["decode"]>[0]> = {},
) {
  return {
    ...baseContext,
    cursor,
    ...overrides,
  };
}

function payloadSegment(cursor: string): string {
  const value = cursor.split(".")[0];
  if (value === undefined) {
    throw new Error("test cursor has no payload segment");
  }
  return value;
}

function cursorPayload(cursor: string): Record<string, unknown> {
  return JSON.parse(
    Buffer.from(payloadSegment(cursor), "base64url").toString("utf8"),
  ) as Record<string, unknown>;
}

function signRawPayload(
  rawPayload: string,
  context: {
    readonly ownerUserId?: string;
    readonly accountAddress?: string;
    readonly bindingVersion?: string;
    readonly scope?: PerpPrivateReadCursorScope;
  } = {},
): string {
  const effective = {
    ...baseContext,
    ...context,
  };
  const payloadBytes = Buffer.from(rawPayload, "utf8");
  const mac = createHmac("sha256", secret)
    .update("loop.perp-private-read-cursor\0v1", "utf8")
    .update("\0network\0", "utf8")
    .update("testnet", "utf8")
    .update("\0market\0", "utf8")
    .update("core_perps", "utf8")
    .update("\0dex\0", "utf8")
    .update("", "utf8")
    .update("\0owner\0", "utf8")
    .update(effective.ownerUserId, "utf8")
    .update("\0account\0", "utf8")
    .update(effective.accountAddress.toLowerCase(), "utf8")
    .update("\0binding_version\0", "utf8")
    .update(effective.bindingVersion, "utf8")
    .update("\0scope\0", "utf8")
    .update(effective.scope, "utf8")
    .update("\0payload\0", "utf8")
    .update(payloadBytes)
    .digest("base64url");

  return `${payloadBytes.toString("base64url")}.${mac}`;
}

function validRawPayload(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    v: 1,
    scope: "positions",
    limit: 50,
    expires:
      Math.floor(observedAt.getTime() / 1_000) +
      PERP_PRIVATE_READ_CURSOR_DEFAULT_TTL_SECONDS,
    provider_state_iv: Buffer.alloc(12, 1).toString("base64url"),
    provider_state_ciphertext: Buffer.from("encrypted", "utf8").toString(
      "base64url",
    ),
    provider_state_tag: Buffer.alloc(16, 2).toString("base64url"),
    ...overrides,
  };
}

function expectInvalidCursor(action: () => unknown): void {
  let result: unknown;
  try {
    result = action();
  } catch (error) {
    result = error;
  }

  expect(result).toBeInstanceOf(InvalidPerpReadCursorError);
  expect(result).toEqual(
    expect.objectContaining({
      name: "InvalidPerpReadCursorError",
      code: "invalid_perp_read_cursor",
      message: "The Perp read cursor is invalid or expired",
    }),
  );
}

describe("Perp private-read cursor codec", () => {
  it("round-trips an opaque cursor and returns only a frozen provider continuation", () => {
    const cursorCodec = codec();
    const cursor = cursorCodec.encode(encodeInput());
    const decoded = cursorCodec.decode(decodeInput(cursor));

    expect(decoded).toEqual({ limit: 50, providerCursorState });
    expect(Object.keys(decoded)).toEqual(["limit", "providerCursorState"]);
    expect(Object.isFrozen(decoded)).toBe(true);
    expect(cursor).toMatch(/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);
  });

  it("puts only encrypted pagination state and the default 600-second expiry in the authenticated payload", () => {
    const cursor = codec().encode(encodeInput());
    const payload = cursorPayload(cursor);

    expect(payload).toMatchObject({
      v: 1,
      scope: "positions",
      limit: 50,
      expires:
        Math.floor(observedAt.getTime() / 1_000) +
        PERP_PRIVATE_READ_CURSOR_DEFAULT_TTL_SECONDS,
    });
    for (const key of [
      "provider_state_iv",
      "provider_state_ciphertext",
      "provider_state_tag",
    ] as const) {
      const encryptedValue = payload[key];
      expect(typeof encryptedValue).toBe("string");
      expect(encryptedValue as string).toMatch(/^[A-Za-z0-9_-]+$/);
    }
    expect(Object.keys(payload)).toEqual([
      "v",
      "scope",
      "limit",
      "expires",
      "provider_state_iv",
      "provider_state_ciphertext",
      "provider_state_tag",
    ]);
    const decodedPayload = JSON.stringify(payload);
    expect(decodedPayload).not.toContain(providerCursorState);
    expect(decodedPayload).not.toContain(ownerUserId);
    expect(decodedPayload).not.toContain(accountAddress);
    expect(payload).not.toHaveProperty("bindingVersion");
  });

  it.each([accountAddress, ownerUserId, "did:privy:verified-user"])(
    "encrypts a provider continuation containing server authority %s",
    (authority) => {
      const providerStateWithAuthority = Buffer.from(
        authority,
        "utf8",
      ).toString("base64url");
      const cursorCodec = codec();
      const cursor = cursorCodec.encode(
        encodeInput({ providerCursorState: providerStateWithAuthority }),
      );
      const serializedPayload = JSON.stringify(cursorPayload(cursor));

      expect(serializedPayload).not.toContain(authority);
      expect(serializedPayload).not.toContain(providerStateWithAuthority);
      expect(cursorCodec.decode(decodeInput(cursor))).toEqual({
        limit: 50,
        providerCursorState: providerStateWithAuthority,
      });
    },
  );

  it("canonicalizes the account address for both encoding and verification", () => {
    const cursorCodec = codec();
    const cursor = cursorCodec.encode(
      encodeInput({ accountAddress: mixedCaseAccountAddress }),
    );

    expect(cursorCodec.decode(decodeInput(cursor, { accountAddress }))).toEqual(
      { limit: 50, providerCursorState },
    );
  });

  it("supports an explicitly bounded TTL", () => {
    const cursorCodec = createPerpPrivateReadCursorCodec({
      secret,
      ttlSeconds: 30,
      now: () => observedAt,
    });
    const cursor = cursorCodec.encode(encodeInput());

    expect(cursorPayload(cursor)["expires"]).toBe(
      Math.floor(observedAt.getTime() / 1_000) + 30,
    );
  });

  it("copies a secret of at least 32 bytes and rejects weak secrets or invalid TTLs", () => {
    expect(() =>
      createPerpPrivateReadCursorCodec({ secret: Buffer.alloc(31) }),
    ).toThrow("Perp read cursor HMAC secret is invalid");
    expect(() =>
      createPerpPrivateReadCursorCodec({
        secret,
        ttlSeconds: 0,
      }),
    ).toThrow("Perp read cursor TTL is invalid");
    expect(() =>
      createPerpPrivateReadCursorCodec({
        secret,
        ttlSeconds: 3_601,
      }),
    ).toThrow("Perp read cursor TTL is invalid");

    const mutableSecret = Buffer.from(secret);
    const cursorCodec = createPerpPrivateReadCursorCodec({
      secret: mutableSecret,
      now: () => observedAt,
    });
    const cursor = cursorCodec.encode(encodeInput());
    mutableSecret.fill(0);
    expect(cursorCodec.decode(decodeInput(cursor))).toEqual({
      limit: 50,
      providerCursorState,
    });
  });

  it.each([
    PERP_PRIVATE_READ_CURSOR_MIN_LIMIT,
    PERP_PRIVATE_READ_CURSOR_MAX_LIMIT,
  ])("accepts the bounded pagination limit %s", (limit) => {
    const cursorCodec = codec();
    const cursor = cursorCodec.encode(encodeInput({ limit }));

    expect(cursorCodec.decode(decodeInput(cursor))).toEqual({
      limit,
      providerCursorState,
    });
  });

  it("accepts a canonical nonempty provider state at the exact maximum length", () => {
    const maximumState = Buffer.alloc(
      (PERP_PRIVATE_READ_CURSOR_MAX_PROVIDER_STATE_LENGTH * 3) / 4,
      0xa5,
    ).toString("base64url");
    expect(maximumState).toHaveLength(
      PERP_PRIVATE_READ_CURSOR_MAX_PROVIDER_STATE_LENGTH,
    );

    const cursorCodec = codec();
    const cursor = cursorCodec.encode(
      encodeInput({ providerCursorState: maximumState }),
    );
    expect(cursorCodec.decode(decodeInput(cursor))).toEqual({
      limit: 50,
      providerCursorState: maximumState,
    });
  });

  it.each([
    ["zero limit", { limit: 0 }],
    ["oversized limit", { limit: 51 }],
    ["fractional limit", { limit: 1.5 }],
    ["empty provider state", { providerCursorState: "" }],
    ["padded provider state", { providerCursorState: "YWJj=" }],
    ["noncanonical provider state", { providerCursorState: "AB" }],
    [
      "oversized provider state",
      { providerCursorState: Buffer.alloc(577, 1).toString("base64url") },
    ],
  ])("rejects %s during encoding", (_name, overrides) => {
    expectInvalidCursor(() => codec().encode(encodeInput(overrides)));
  });

  it("rejects a cursor at its exact expiry boundary", () => {
    const expiresAt = new Date(
      observedAt.getTime() +
        PERP_PRIVATE_READ_CURSOR_DEFAULT_TTL_SECONDS * 1_000,
    );
    const cursorCodec = codec(() => observedAt);
    const cursor = cursorCodec.encode(encodeInput());
    const decoder = codec(() => expiresAt);

    expectInvalidCursor(() => decoder.decode(decodeInput(cursor)));
  });

  it.each([
    ["owner", { ownerUserId: otherOwnerUserId }],
    ["wallet", { accountAddress: otherAccountAddress }],
    ["binding version", { bindingVersion: "8" }],
    ["route scope", { scope: "orders" as const }],
  ])(
    "returns the same sanitized error across a mismatched %s",
    (_name, overrides) => {
      const cursorCodec = codec();
      const cursor = cursorCodec.encode(encodeInput());

      expectInvalidCursor(() =>
        cursorCodec.decode(decodeInput(cursor, overrides)),
      );
    },
  );

  it.each([
    "",
    "one-segment",
    "one.two.three",
    "*.YWJj",
    "YWJj.*",
    `${"A".repeat(1_537)}`,
    `YWJj.${Buffer.alloc(1).toString("base64url")}`,
  ])("rejects malformed opaque syntax without exposing its value", (cursor) => {
    expectInvalidCursor(() => codec().decode(decodeInput(cursor)));
  });

  it("rejects independently tampered payload and MAC segments", () => {
    const cursorCodec = codec();
    const cursor = cursorCodec.encode(encodeInput());
    const [payload, mac] = cursor.split(".") as [string, string];
    const tamperedPayload = `${payload.slice(0, -1)}${payload.endsWith("A") ? "B" : "A"}`;
    const tamperedMac = `${mac.slice(0, -1)}${mac.endsWith("A") ? "B" : "A"}`;

    expectInvalidCursor(() =>
      cursorCodec.decode(decodeInput(`${tamperedPayload}.${mac}`)),
    );
    expectInvalidCursor(() =>
      cursorCodec.decode(decodeInput(`${payload}.${tamperedMac}`)),
    );
  });

  it.each([
    ["unknown key", JSON.stringify(validRawPayload({ extra: "forbidden" }))],
    [
      "missing key",
      JSON.stringify({
        v: 1,
        scope: "positions",
        limit: 50,
        expires: validRawPayload()["expires"],
      }),
    ],
    ["wrong version", JSON.stringify(validRawPayload({ v: 2 }))],
    ["wrong scope", JSON.stringify(validRawPayload({ scope: "account" }))],
    ["wrong limit type", JSON.stringify(validRawPayload({ limit: "50" }))],
    ["unsafe expiry", JSON.stringify(validRawPayload({ expires: 1e100 }))],
    [
      "empty state ciphertext",
      JSON.stringify(validRawPayload({ provider_state_ciphertext: "" })),
    ],
    [
      "noncanonical key order",
      JSON.stringify({
        scope: "positions",
        v: 1,
        limit: 50,
        expires: validRawPayload()["expires"],
        provider_state_iv: validRawPayload()["provider_state_iv"],
        provider_state_ciphertext:
          validRawPayload()["provider_state_ciphertext"],
        provider_state_tag: validRawPayload()["provider_state_tag"],
      }),
    ],
    ["whitespace", ` ${JSON.stringify(validRawPayload())}`],
    [
      "duplicate key",
      `{"v":1,"v":1,"scope":"positions","limit":50,"expires":${String(validRawPayload()["expires"])},"provider_state_iv":"${String(validRawPayload()["provider_state_iv"])}","provider_state_ciphertext":"${String(validRawPayload()["provider_state_ciphertext"])}","provider_state_tag":"${String(validRawPayload()["provider_state_tag"])}"}`,
    ],
  ])(
    "rejects a correctly signed but noncanonical payload with %s",
    (_name, rawPayload) => {
      const cursor = signRawPayload(rawPayload);
      expectInvalidCursor(() => codec().decode(decodeInput(cursor)));
    },
  );

  it("uses one uniform error for an invalid clock during decoding", () => {
    const cursor = codec().encode(encodeInput());
    const invalidClockCodec = codec(() => new Date(Number.NaN));

    expectInvalidCursor(() => invalidClockCodec.decode(decodeInput(cursor)));
  });
});

describe("Perp private-read unavailable ports", () => {
  it("requires a verified wallet rather than guessing one", async () => {
    const resolver = createUnavailablePerpWalletBindingResolver();
    const resolution = resolver.resolve({
      ownerUserId,
      privyUserId: "did:privy:verified-user",
      signal: new AbortController().signal,
    });

    await expect(resolution).rejects.toBeInstanceOf(WalletBindingRequiredError);
    await expect(resolution).rejects.not.toBeInstanceOf(
      WalletBindingResolutionUnavailableError,
    );
  });

  it("fails closed when the Hyperliquid private reader is unavailable", async () => {
    const reader = createUnavailableHyperliquidPrivateReader();

    await expect(
      reader.read({
        kind: "account",
        network: "testnet",
        dex: "",
        accountAddress,
        transportAttemptId: "a16e4f15-cd54-47d2-91e8-a7e31ba90c6e",
        signal: new AbortController().signal,
      }),
    ).rejects.toBeInstanceOf(HyperliquidPrivateReaderUnavailableError);
  });

  it("allows only the two pre-response retry classifications", () => {
    expect(
      new RetryableHyperliquidReadError("pre_response_transport"),
    ).toMatchObject({ reason: "pre_response_transport" });
    expect(new RetryableHyperliquidReadError("provider_5xx")).toMatchObject({
      reason: "provider_5xx",
    });
    expect(
      () =>
        new RetryableHyperliquidReadError(
          "post_response_429" as "provider_5xx",
        ),
    ).toThrow("Hyperliquid read retry reason is invalid");
  });
});
