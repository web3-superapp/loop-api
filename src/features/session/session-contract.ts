import { V2ApiError } from "../../core/http/v2-error.js";
import { v2ContractVersion } from "../meta/product-policy.js";
import {
  clientVersionMaximumLength,
  clientVersionMinimumLength,
  clientVersionSemver2PatternSource,
  isValidClientVersion,
} from "./client-version.js";
import type { DeviceSessionClientPlatform } from "./device-session-repository.js";

const canonicalUuidPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const canonicalUuidV4Pattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
export const v2SessionHeaderNames = Object.freeze({
  clientVersion: "x-loop-client-version",
  contractVersion: "x-loop-contract-version",
  deviceId: "x-loop-device-id",
  idempotencyKey: "idempotency-key",
  platform: "x-loop-platform",
  sessionId: "x-loop-session-id",
} as const);

export const v2CommonHeadersSchema = {
  type: "object",
  additionalProperties: true,
  required: [
    v2SessionHeaderNames.clientVersion,
    v2SessionHeaderNames.contractVersion,
  ],
  properties: {
    [v2SessionHeaderNames.clientVersion]: {
      type: "string",
      minLength: clientVersionMinimumLength,
      maxLength: clientVersionMaximumLength,
      pattern: clientVersionSemver2PatternSource,
    },
    [v2SessionHeaderNames.contractVersion]: {
      type: "string",
      const: v2ContractVersion,
    },
  },
} as const;

export const v2SessionWriteHeadersSchema = {
  type: "object",
  additionalProperties: true,
  required: [
    ...v2CommonHeadersSchema.required,
    v2SessionHeaderNames.deviceId,
    v2SessionHeaderNames.idempotencyKey,
    v2SessionHeaderNames.platform,
  ],
  properties: {
    ...v2CommonHeadersSchema.properties,
    [v2SessionHeaderNames.deviceId]: {
      type: "string",
      pattern:
        "^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$",
    },
    [v2SessionHeaderNames.idempotencyKey]: {
      type: "string",
      pattern:
        "^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$",
    },
    [v2SessionHeaderNames.platform]: {
      type: "string",
      enum: ["android", "ios"],
    },
  },
} as const;

export const v2SessionLogoutHeadersSchema = {
  type: "object",
  additionalProperties: true,
  required: [
    ...v2SessionWriteHeadersSchema.required,
    v2SessionHeaderNames.sessionId,
  ],
  properties: {
    ...v2SessionWriteHeadersSchema.properties,
    [v2SessionHeaderNames.sessionId]: {
      type: "string",
      pattern:
        "^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$",
    },
  },
} as const;

export interface V2CommonRequestMetadata {
  readonly clientVersion: string;
  readonly contractVersion: typeof v2ContractVersion;
}

export interface V2SessionWriteMetadata extends V2CommonRequestMetadata {
  readonly deviceId: string;
  readonly idempotencyKey: string;
  readonly platform: DeviceSessionClientPlatform;
}

export interface V2SessionLogoutMetadata extends V2SessionWriteMetadata {
  readonly sessionId: string;
}

const commonLoopHeaders = new Set<string>([
  v2SessionHeaderNames.clientVersion,
  v2SessionHeaderNames.contractVersion,
]);
const sessionWriteLoopHeaders = new Set<string>([
  ...commonLoopHeaders,
  v2SessionHeaderNames.deviceId,
  v2SessionHeaderNames.platform,
]);
const sessionLogoutLoopHeaders = new Set<string>([
  ...sessionWriteLoopHeaders,
  v2SessionHeaderNames.sessionId,
]);

function assertOnlyAllowedLoopHeaders(
  rawHeaders: readonly string[],
  allowedNames: ReadonlySet<string>,
): void {
  if (rawHeaders.length % 2 !== 0) {
    throw V2ApiError.invalidRequest();
  }

  for (let index = 0; index < rawHeaders.length; index += 2) {
    const name = rawHeaders[index]?.toLowerCase();
    if (
      name !== undefined &&
      name.startsWith("x-loop-") &&
      !allowedNames.has(name)
    ) {
      throw V2ApiError.invalidRequest();
    }
  }
}

function collectRawHeaderValues(
  rawHeaders: readonly string[],
  expectedName: string,
): readonly string[] {
  if (rawHeaders.length % 2 !== 0) {
    throw V2ApiError.invalidRequest();
  }

  const values: string[] = [];
  for (let index = 0; index < rawHeaders.length; index += 2) {
    if (rawHeaders[index]?.toLowerCase() === expectedName) {
      values.push(rawHeaders[index + 1] ?? "");
    }
  }
  return values;
}

function readExactlyOneHeader(
  rawHeaders: readonly string[],
  expectedName: string,
): string {
  const values = collectRawHeaderValues(rawHeaders, expectedName);
  if (values.length !== 1 || values[0] === undefined) {
    throw V2ApiError.invalidRequest();
  }
  return values[0];
}

function parseV2CommonRequestMetadataUnchecked(
  rawHeaders: readonly string[],
): V2CommonRequestMetadata {
  const contractVersion = readExactlyOneHeader(
    rawHeaders,
    v2SessionHeaderNames.contractVersion,
  );
  if (contractVersion !== v2ContractVersion) {
    throw V2ApiError.versionConflict();
  }

  const clientVersion = readExactlyOneHeader(
    rawHeaders,
    v2SessionHeaderNames.clientVersion,
  );
  if (!isValidClientVersion(clientVersion)) {
    throw V2ApiError.invalidRequest();
  }

  return Object.freeze({ clientVersion, contractVersion });
}

export function parseV2CommonRequestMetadata(
  rawHeaders: readonly string[],
): V2CommonRequestMetadata {
  assertOnlyAllowedLoopHeaders(rawHeaders, commonLoopHeaders);
  return parseV2CommonRequestMetadataUnchecked(rawHeaders);
}

export function parseV2SessionWriteMetadata(
  rawHeaders: readonly string[],
): V2SessionWriteMetadata {
  assertOnlyAllowedLoopHeaders(rawHeaders, sessionWriteLoopHeaders);
  const common = parseV2CommonRequestMetadataUnchecked(rawHeaders);
  const deviceId = readExactlyOneHeader(
    rawHeaders,
    v2SessionHeaderNames.deviceId,
  );
  const idempotencyKey = readExactlyOneHeader(
    rawHeaders,
    v2SessionHeaderNames.idempotencyKey,
  );
  const platform = readExactlyOneHeader(
    rawHeaders,
    v2SessionHeaderNames.platform,
  );

  if (
    !canonicalUuidV4Pattern.test(deviceId) ||
    !canonicalUuidV4Pattern.test(idempotencyKey) ||
    (platform !== "android" && platform !== "ios")
  ) {
    throw V2ApiError.invalidRequest();
  }

  return Object.freeze({
    ...common,
    deviceId,
    idempotencyKey,
    platform,
  });
}

export function parseV2SessionLogoutMetadata(
  rawHeaders: readonly string[],
): V2SessionLogoutMetadata {
  assertOnlyAllowedLoopHeaders(rawHeaders, sessionLogoutLoopHeaders);
  const common = parseV2CommonRequestMetadataUnchecked(rawHeaders);
  const deviceId = readExactlyOneHeader(
    rawHeaders,
    v2SessionHeaderNames.deviceId,
  );
  const idempotencyKey = readExactlyOneHeader(
    rawHeaders,
    v2SessionHeaderNames.idempotencyKey,
  );
  const platform = readExactlyOneHeader(
    rawHeaders,
    v2SessionHeaderNames.platform,
  );
  if (
    !canonicalUuidV4Pattern.test(deviceId) ||
    !canonicalUuidV4Pattern.test(idempotencyKey) ||
    (platform !== "android" && platform !== "ios")
  ) {
    throw V2ApiError.invalidRequest();
  }
  const sessionId = readExactlyOneHeader(
    rawHeaders,
    v2SessionHeaderNames.sessionId,
  );
  if (!canonicalUuidPattern.test(sessionId)) {
    throw V2ApiError.invalidRequest();
  }

  return Object.freeze({
    ...common,
    deviceId,
    idempotencyKey,
    platform,
    sessionId,
  });
}
