import {
  createCipheriv,
  createDecipheriv,
  createHmac,
  createSecretKey,
  randomBytes,
  timingSafeEqual,
  type KeyObject,
} from "node:crypto";

const hmacDomain = "loop.perp-private-read-cursor\0v1";
const encryptionKeyDomain =
  "loop.perp-private-read-cursor\0v1\0provider-state-encryption-key";
const hmacNetwork = "testnet";
const hmacMarket = "core_perps";
const hmacDex = "";
const minimumSecretBytes = 32;
const defaultTtlSeconds = 600;
const minimumTtlSeconds = 1;
const maximumTtlSeconds = 3_600;
const minimumLimit = 1;
const maximumLimit = 50;
const maximumProviderCursorStateLength = 768;
const maximumProviderCursorStateBytes =
  (maximumProviderCursorStateLength * 3) / 4;
const maximumPayloadBytes = 1_024;
const maximumCursorLength = 1_536;
const sha256Bytes = 32;
const aes256KeyBytes = 32;
const aesGcmIvBytes = 12;
const aesGcmAuthTagBytes = 16;
const base64UrlPattern = /^[A-Za-z0-9_-]+$/;
const ownerUserIdPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const accountAddressPattern = /^0x[0-9a-fA-F]{40}$/;
const positiveDecimalPattern = /^[1-9][0-9]{0,18}$/;
const maximumBindingVersion = 9_223_372_036_854_775_807n;
const cursorScopes: ReadonlySet<string> = new Set([
  "positions",
  "orders",
  "fills",
  "funding",
]);

export const PERP_PRIVATE_READ_CURSOR_DEFAULT_TTL_SECONDS = defaultTtlSeconds;
export const PERP_PRIVATE_READ_CURSOR_MIN_LIMIT = minimumLimit;
export const PERP_PRIVATE_READ_CURSOR_MAX_LIMIT = maximumLimit;
export const PERP_PRIVATE_READ_CURSOR_MAX_PROVIDER_STATE_LENGTH =
  maximumProviderCursorStateLength;

export type PerpPrivateReadCursorScope =
  "positions" | "orders" | "fills" | "funding";

interface PerpPrivateReadCursorContext {
  readonly ownerUserId: string;
  readonly accountAddress: string;
  readonly bindingVersion: string;
  readonly scope: PerpPrivateReadCursorScope;
}

export interface EncodePerpPrivateReadCursorInput extends PerpPrivateReadCursorContext {
  readonly limit: number;
  readonly providerCursorState: string;
}

export interface DecodePerpPrivateReadCursorInput extends PerpPrivateReadCursorContext {
  readonly cursor: string;
}

export interface DecodedPerpPrivateReadCursor {
  readonly limit: number;
  readonly providerCursorState: string;
}

export interface CreatePerpPrivateReadCursorCodecInput {
  readonly secret: Uint8Array;
  readonly ttlSeconds?: number;
  readonly now?: () => Date;
}

export interface PerpPrivateReadCursorCodec {
  encode(input: EncodePerpPrivateReadCursorInput): string;
  decode(input: DecodePerpPrivateReadCursorInput): DecodedPerpPrivateReadCursor;
}

interface CursorPayloadHeader {
  readonly v: 1;
  readonly scope: PerpPrivateReadCursorScope;
  readonly limit: number;
  readonly expires: number;
}

interface CursorPayload extends CursorPayloadHeader {
  readonly provider_state_iv: string;
  readonly provider_state_ciphertext: string;
  readonly provider_state_tag: string;
}

interface CanonicalCursorContext {
  readonly ownerUserId: string;
  readonly accountAddress: string;
  readonly bindingVersion: string;
  readonly scope: PerpPrivateReadCursorScope;
}

export class InvalidPerpReadCursorError extends Error {
  readonly code = "invalid_perp_read_cursor";

  constructor() {
    super("The Perp read cursor is invalid or expired");
    this.name = "InvalidPerpReadCursorError";
  }
}

function invalidCursor(): never {
  throw new InvalidPerpReadCursorError();
}

interface CursorKeys {
  readonly hmac: KeyObject;
  readonly encryption: KeyObject;
}

function createCursorKeys(secret: Uint8Array): CursorKeys {
  if (
    !(secret instanceof Uint8Array) ||
    secret.byteLength < minimumSecretBytes
  ) {
    throw new TypeError("Perp read cursor HMAC secret is invalid");
  }

  const secretCopy = Buffer.from(secret);
  let encryptionKeyBytes: Buffer | undefined;

  try {
    encryptionKeyBytes = createHmac("sha256", secretCopy)
      .update(encryptionKeyDomain, "utf8")
      .digest();
    if (encryptionKeyBytes.length !== aes256KeyBytes) {
      throw new TypeError("Perp read cursor encryption key is invalid");
    }

    return Object.freeze({
      hmac: createSecretKey(secretCopy),
      encryption: createSecretKey(encryptionKeyBytes),
    });
  } finally {
    secretCopy.fill(0);
    encryptionKeyBytes?.fill(0);
  }
}

function validateTtlSeconds(value: number): number {
  if (
    !Number.isInteger(value) ||
    value < minimumTtlSeconds ||
    value > maximumTtlSeconds
  ) {
    throw new TypeError("Perp read cursor TTL is invalid");
  }

  return value;
}

function readEpochSeconds(now: () => Date, forDecode: boolean): number {
  const observedAt = now();
  const milliseconds = observedAt.getTime();

  if (!Number.isFinite(milliseconds) || milliseconds < 0) {
    if (forDecode) {
      return invalidCursor();
    }
    throw new TypeError("Perp read cursor clock is invalid");
  }

  return Math.floor(milliseconds / 1_000);
}

function validateScope(value: string): PerpPrivateReadCursorScope {
  if (!cursorScopes.has(value)) {
    return invalidCursor();
  }

  return value as PerpPrivateReadCursorScope;
}

function validateLimit(value: number): number {
  if (
    !Number.isInteger(value) ||
    value < minimumLimit ||
    value > maximumLimit
  ) {
    return invalidCursor();
  }

  return value;
}

function canonicalizeContext(
  input: PerpPrivateReadCursorContext,
): CanonicalCursorContext {
  if (
    typeof input.ownerUserId !== "string" ||
    !ownerUserIdPattern.test(input.ownerUserId) ||
    typeof input.accountAddress !== "string" ||
    !accountAddressPattern.test(input.accountAddress) ||
    typeof input.bindingVersion !== "string" ||
    !positiveDecimalPattern.test(input.bindingVersion)
  ) {
    return invalidCursor();
  }

  let bindingVersion: bigint;
  try {
    bindingVersion = BigInt(input.bindingVersion);
  } catch {
    return invalidCursor();
  }

  if (bindingVersion > maximumBindingVersion) {
    return invalidCursor();
  }

  return {
    ownerUserId: input.ownerUserId,
    accountAddress: input.accountAddress.toLowerCase(),
    bindingVersion: input.bindingVersion,
    scope: validateScope(input.scope),
  };
}

function validateProviderCursorState(value: string): string {
  if (
    typeof value !== "string" ||
    value.length < 1 ||
    value.length > maximumProviderCursorStateLength ||
    !base64UrlPattern.test(value)
  ) {
    return invalidCursor();
  }

  let decoded: Buffer;
  try {
    decoded = Buffer.from(value, "base64url");
  } catch {
    return invalidCursor();
  }

  if (decoded.length < 1 || decoded.toString("base64url") !== value) {
    return invalidCursor();
  }

  return value;
}

function canonicalPayloadJson(payload: CursorPayload): string {
  return JSON.stringify({
    v: payload.v,
    scope: payload.scope,
    limit: payload.limit,
    expires: payload.expires,
    provider_state_iv: payload.provider_state_iv,
    provider_state_ciphertext: payload.provider_state_ciphertext,
    provider_state_tag: payload.provider_state_tag,
  });
}

function providerStateAssociatedData(
  context: CanonicalCursorContext,
  header: CursorPayloadHeader,
): Buffer {
  return Buffer.from(
    [
      hmacDomain,
      "\0network\0",
      hmacNetwork,
      "\0market\0",
      hmacMarket,
      "\0dex\0",
      hmacDex,
      "\0owner\0",
      context.ownerUserId,
      "\0account\0",
      context.accountAddress,
      "\0binding_version\0",
      context.bindingVersion,
      "\0scope\0",
      context.scope,
      "\0limit\0",
      String(header.limit),
      "\0expires\0",
      String(header.expires),
    ].join(""),
    "utf8",
  );
}

function encryptProviderCursorState(
  key: KeyObject,
  context: CanonicalCursorContext,
  header: CursorPayloadHeader,
  value: string,
): Pick<
  CursorPayload,
  "provider_state_iv" | "provider_state_ciphertext" | "provider_state_tag"
> {
  const canonicalState = validateProviderCursorState(value);
  const plaintext = Buffer.from(canonicalState, "base64url");
  const iv = randomBytes(aesGcmIvBytes);
  const associatedData = providerStateAssociatedData(context, header);

  try {
    const cipher = createCipheriv("aes-256-gcm", key, iv, {
      authTagLength: aesGcmAuthTagBytes,
    });
    cipher.setAAD(associatedData, { plaintextLength: plaintext.length });
    const ciphertext = Buffer.concat([
      cipher.update(plaintext),
      cipher.final(),
    ]);
    const tag = cipher.getAuthTag();

    return Object.freeze({
      provider_state_iv: iv.toString("base64url"),
      provider_state_ciphertext: ciphertext.toString("base64url"),
      provider_state_tag: tag.toString("base64url"),
    });
  } finally {
    plaintext.fill(0);
    associatedData.fill(0);
    iv.fill(0);
  }
}

function decodeBase64Url(value: string, maximumBytes: number): Buffer {
  if (
    value.length < 1 ||
    !base64UrlPattern.test(value) ||
    value.length > Math.ceil((maximumBytes * 4) / 3)
  ) {
    return invalidCursor();
  }

  let decoded: Buffer;
  try {
    decoded = Buffer.from(value, "base64url");
  } catch {
    return invalidCursor();
  }

  if (
    decoded.length < 1 ||
    decoded.length > maximumBytes ||
    decoded.toString("base64url") !== value
  ) {
    return invalidCursor();
  }

  return decoded;
}

function decodeExactBase64Url(value: string, expectedBytes: number): Buffer {
  const decoded = decodeBase64Url(value, expectedBytes);
  if (decoded.length !== expectedBytes) {
    decoded.fill(0);
    return invalidCursor();
  }
  return decoded;
}

function decryptProviderCursorState(
  key: KeyObject,
  context: CanonicalCursorContext,
  payload: CursorPayload,
): string {
  const iv = decodeExactBase64Url(payload.provider_state_iv, aesGcmIvBytes);
  const ciphertext = decodeBase64Url(
    payload.provider_state_ciphertext,
    maximumProviderCursorStateBytes,
  );
  const tag = decodeExactBase64Url(
    payload.provider_state_tag,
    aesGcmAuthTagBytes,
  );
  const associatedData = providerStateAssociatedData(context, payload);
  let plaintext: Buffer | undefined;

  try {
    const decipher = createDecipheriv("aes-256-gcm", key, iv, {
      authTagLength: aesGcmAuthTagBytes,
    });
    decipher.setAAD(associatedData, { plaintextLength: ciphertext.length });
    decipher.setAuthTag(tag);
    plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
    return validateProviderCursorState(plaintext.toString("base64url"));
  } catch {
    return invalidCursor();
  } finally {
    iv.fill(0);
    ciphertext.fill(0);
    tag.fill(0);
    associatedData.fill(0);
    plaintext?.fill(0);
  }
}

function cursorMac(
  key: KeyObject,
  context: CanonicalCursorContext,
  payloadBytes: Uint8Array,
): Buffer {
  return createHmac("sha256", key)
    .update(hmacDomain, "utf8")
    .update("\0network\0", "utf8")
    .update(hmacNetwork, "utf8")
    .update("\0market\0", "utf8")
    .update(hmacMarket, "utf8")
    .update("\0dex\0", "utf8")
    .update(hmacDex, "utf8")
    .update("\0owner\0", "utf8")
    .update(context.ownerUserId, "utf8")
    .update("\0account\0", "utf8")
    .update(context.accountAddress, "utf8")
    .update("\0binding_version\0", "utf8")
    .update(context.bindingVersion, "utf8")
    .update("\0scope\0", "utf8")
    .update(context.scope, "utf8")
    .update("\0payload\0", "utf8")
    .update(payloadBytes)
    .digest();
}

function verifyMac(expectedMac: Buffer, presentedMac: Buffer): void {
  const fixedLengthPresentedMac = Buffer.alloc(sha256Bytes);
  const hasCorrectLength = presentedMac.length === sha256Bytes;

  if (hasCorrectLength) {
    presentedMac.copy(fixedLengthPresentedMac);
  }

  const matches = timingSafeEqual(expectedMac, fixedLengthPresentedMac);
  fixedLengthPresentedMac.fill(0);

  if (!hasCorrectLength || !matches) {
    return invalidCursor();
  }
}

function parsePayload(payloadBytes: Buffer): CursorPayload {
  let json: string;
  try {
    json = new TextDecoder("utf-8", { fatal: true }).decode(payloadBytes);
  } catch {
    return invalidCursor();
  }

  let value: unknown;
  try {
    value = JSON.parse(json);
  } catch {
    return invalidCursor();
  }

  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return invalidCursor();
  }

  const keys = Reflect.ownKeys(value);
  const expectedKeys = [
    "v",
    "scope",
    "limit",
    "expires",
    "provider_state_iv",
    "provider_state_ciphertext",
    "provider_state_tag",
  ];
  if (
    keys.length !== expectedKeys.length ||
    !expectedKeys.every((key) => keys.includes(key))
  ) {
    return invalidCursor();
  }

  const record = value as Record<string, unknown>;
  if (
    record["v"] !== 1 ||
    typeof record["scope"] !== "string" ||
    typeof record["limit"] !== "number" ||
    typeof record["expires"] !== "number" ||
    !Number.isSafeInteger(record["expires"]) ||
    record["expires"] < 1 ||
    typeof record["provider_state_iv"] !== "string" ||
    typeof record["provider_state_ciphertext"] !== "string" ||
    typeof record["provider_state_tag"] !== "string"
  ) {
    return invalidCursor();
  }

  const payload = {
    v: 1,
    scope: validateScope(record["scope"]),
    limit: validateLimit(record["limit"]),
    expires: record["expires"],
    provider_state_iv: record["provider_state_iv"],
    provider_state_ciphertext: record["provider_state_ciphertext"],
    provider_state_tag: record["provider_state_tag"],
  } as const satisfies CursorPayload;

  if (canonicalPayloadJson(payload) !== json) {
    return invalidCursor();
  }

  return payload;
}

export function createPerpPrivateReadCursorCodec(
  input: CreatePerpPrivateReadCursorCodecInput,
): PerpPrivateReadCursorCodec {
  const keys = createCursorKeys(input.secret);
  const ttlSeconds = validateTtlSeconds(input.ttlSeconds ?? defaultTtlSeconds);
  const now = input.now ?? (() => new Date());

  return Object.freeze({
    encode(cursorInput: EncodePerpPrivateReadCursorInput): string {
      const context = canonicalizeContext(cursorInput);
      const header = {
        v: 1,
        scope: context.scope,
        limit: validateLimit(cursorInput.limit),
        expires: readEpochSeconds(now, false) + ttlSeconds,
      } as const satisfies CursorPayloadHeader;
      const payload = {
        ...header,
        ...encryptProviderCursorState(
          keys.encryption,
          context,
          header,
          cursorInput.providerCursorState,
        ),
      } as const satisfies CursorPayload;
      const payloadBytes = Buffer.from(canonicalPayloadJson(payload), "utf8");

      if (payloadBytes.length > maximumPayloadBytes) {
        return invalidCursor();
      }

      const mac = cursorMac(keys.hmac, context, payloadBytes);
      return `${payloadBytes.toString("base64url")}.${mac.toString("base64url")}`;
    },

    decode(
      cursorInput: DecodePerpPrivateReadCursorInput,
    ): DecodedPerpPrivateReadCursor {
      const context = canonicalizeContext(cursorInput);

      if (
        typeof cursorInput.cursor !== "string" ||
        cursorInput.cursor.length < 1 ||
        cursorInput.cursor.length > maximumCursorLength
      ) {
        return invalidCursor();
      }

      const segments = cursorInput.cursor.split(".");
      if (segments.length !== 2) {
        return invalidCursor();
      }

      const payloadSegment = segments[0];
      const macSegment = segments[1];
      if (payloadSegment === undefined || macSegment === undefined) {
        return invalidCursor();
      }

      const payloadBytes = decodeBase64Url(payloadSegment, maximumPayloadBytes);
      const presentedMac = decodeBase64Url(macSegment, sha256Bytes);
      verifyMac(cursorMac(keys.hmac, context, payloadBytes), presentedMac);

      const payload = parsePayload(payloadBytes);
      if (
        payload.scope !== context.scope ||
        payload.expires <= readEpochSeconds(now, true)
      ) {
        return invalidCursor();
      }

      return Object.freeze({
        limit: payload.limit,
        providerCursorState: decryptProviderCursorState(
          keys.encryption,
          context,
          payload,
        ),
      });
    },
  });
}
