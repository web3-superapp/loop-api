import { describe, expect, it } from "vitest";

import { V2ApiError } from "../src/core/http/v2-error.js";
import {
  clientVersionMaximumLength,
  clientVersionSemver2PatternSource,
  isValidClientVersion,
} from "../src/features/session/client-version.js";
import {
  parseV2CommonRequestMetadata,
  parseV2SessionLogoutMetadata,
  parseV2SessionWriteMetadata,
  v2CommonHeadersSchema,
  v2SessionHeaderNames,
} from "../src/features/session/session-contract.js";

const deviceId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const idempotencyKey = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const sessionId = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";

function rawHeaders(entries: Readonly<Record<string, string>>): string[] {
  return Object.entries(entries).flatMap(([name, value]) => [name, value]);
}

describe("V2 session request contract", () => {
  it("parses the exact common and write metadata", () => {
    const commonHeaders = rawHeaders({
      "X-Loop-Contract-Version": "2.0",
      "X-Loop-Client-Version": "1.2.3-beta.1",
    });
    const writeHeaders = rawHeaders({
      "X-Loop-Contract-Version": "2.0",
      "X-Loop-Client-Version": "1.2.3-beta.1",
      "X-Loop-Device-ID": deviceId,
      "Idempotency-Key": idempotencyKey,
      "X-Loop-Platform": "ios",
    });
    const logoutHeaders = rawHeaders({
      "X-Loop-Contract-Version": "2.0",
      "X-Loop-Client-Version": "1.2.3-beta.1",
      "X-Loop-Device-ID": deviceId,
      "Idempotency-Key": idempotencyKey,
      "X-Loop-Platform": "ios",
      "X-Loop-Session-ID": sessionId,
    });

    expect(parseV2CommonRequestMetadata(commonHeaders)).toEqual({
      contractVersion: "2.0",
      clientVersion: "1.2.3-beta.1",
    });
    expect(parseV2SessionWriteMetadata(writeHeaders)).toEqual({
      contractVersion: "2.0",
      clientVersion: "1.2.3-beta.1",
      deviceId,
      idempotencyKey,
      platform: "ios",
    });
    expect(parseV2SessionLogoutMetadata(logoutHeaders)).toEqual({
      contractVersion: "2.0",
      clientVersion: "1.2.3-beta.1",
      deviceId,
      idempotencyKey,
      platform: "ios",
      sessionId,
    });
  });

  it.each([
    "0.0.0",
    "1.2.3-beta.1+42",
    "1.2.3-0",
    "1.2.3-0A",
    "1.2.3+001",
    `1.2.3+${"a".repeat(clientVersionMaximumLength - 6)}`,
  ])("accepts strict SemVer 2.0 client version %s", (clientVersion) => {
    const parsed = parseV2CommonRequestMetadata(
      rawHeaders({
        "x-loop-contract-version": "2.0",
        "x-loop-client-version": clientVersion,
      }),
    );
    const schema =
      v2CommonHeadersSchema.properties[v2SessionHeaderNames.clientVersion];

    expect(parsed.clientVersion).toBe(clientVersion);
    expect(isValidClientVersion(clientVersion)).toBe(true);
    expect(schema.pattern).toBe(clientVersionSemver2PatternSource);
    expect(
      clientVersion.length >= schema.minLength &&
        clientVersion.length <= schema.maxLength &&
        new RegExp(schema.pattern).test(clientVersion),
    ).toBe(true);
  });

  it.each([
    "01.2.3",
    "1.02.3",
    "1.2.03",
    "1.2.3-01",
    "1.2.3-.",
    "1.2.3+.",
    "1.2.3-alpha..1",
    "1.2.3+build..1",
    "1.2.3-beta+build+extra",
    "v1.2.3",
    "1.2.3\n",
    `1.2.3+${"a".repeat(clientVersionMaximumLength - 5)}`,
  ])("rejects non-SemVer client version %j", (clientVersion) => {
    expect(() =>
      parseV2CommonRequestMetadata(
        rawHeaders({
          "x-loop-contract-version": "2.0",
          "x-loop-client-version": clientVersion,
        }),
      ),
    ).toThrowError(
      expect.objectContaining({
        constructor: V2ApiError,
        code: "INVALID_REQUEST",
      }),
    );
    expect(isValidClientVersion(clientVersion)).toBe(false);
    const schema =
      v2CommonHeadersSchema.properties[v2SessionHeaderNames.clientVersion];
    expect(
      clientVersion.length >= schema.minLength &&
        clientVersion.length <= schema.maxLength &&
        new RegExp(schema.pattern).test(clientVersion),
    ).toBe(false);
  });

  it("uses VERSION_CONFLICT for a different contract before domain work", () => {
    expect(() =>
      parseV2CommonRequestMetadata(
        rawHeaders({
          "x-loop-contract-version": "2",
          "x-loop-client-version": "1.2.3",
        }),
      ),
    ).toThrowError(
      expect.objectContaining({
        constructor: V2ApiError,
        code: "VERSION_CONFLICT",
      }),
    );
  });

  it.each([
    ["missing header", ["x-loop-contract-version", "2.0"]],
    [
      "duplicate header",
      [
        "x-loop-contract-version",
        "2.0",
        "x-loop-client-version",
        "1.2.3",
        "X-Loop-Client-Version",
        "1.2.3",
      ],
    ],
    [
      "non-canonical UUID",
      rawHeaders({
        "x-loop-contract-version": "2.0",
        "x-loop-client-version": "1.2.3",
        "x-loop-device-id": deviceId.toUpperCase(),
        "idempotency-key": idempotencyKey,
        "x-loop-platform": "android",
      }),
    ],
    [
      "leading-zero client version",
      rawHeaders({
        "x-loop-contract-version": "2.0",
        "x-loop-client-version": "01.2.3",
        "x-loop-device-id": deviceId,
        "idempotency-key": idempotencyKey,
        "x-loop-platform": "android",
      }),
    ],
    [
      "unknown reserved LOOP header",
      rawHeaders({
        "x-loop-contract-version": "2.0",
        "x-loop-client-version": "1.2.3",
        "x-loop-device-id": deviceId,
        "idempotency-key": idempotencyKey,
        "x-loop-platform": "android",
        "x-loop-account-id": "attacker-selected",
      }),
    ],
    [
      "session header on bootstrap metadata",
      rawHeaders({
        "x-loop-contract-version": "2.0",
        "x-loop-client-version": "1.2.3",
        "x-loop-device-id": deviceId,
        "idempotency-key": idempotencyKey,
        "x-loop-platform": "android",
        "x-loop-session-id": sessionId,
      }),
    ],
  ])("rejects %s as INVALID_REQUEST", (_name, headers) => {
    expect(() => parseV2SessionWriteMetadata(headers)).toThrowError(
      expect.objectContaining({
        constructor: V2ApiError,
        code: "INVALID_REQUEST",
      }),
    );
  });
});
