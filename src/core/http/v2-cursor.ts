import {
  createCipheriv,
  createDecipheriv,
  createHmac,
  createSecretKey,
  randomBytes,
  timingSafeEqual,
  type KeyObject,
} from "node:crypto";

/**
 * Opaque, owner/route/filter-bound V2 list cursor.
 *
 * The continuation is AES-256-GCM encrypted and the whole envelope is HMAC
 * bound to the owner, route, and canonical filter, so a cursor cannot be
 * replayed across accounts, routes, or filters, inspected by the client, or
 * used after its TTL. Modules from D2 onward build their list pagination on
 * this codec with the independent V2_CURSOR_HMAC_SECRET.
 */

const hmacDomain = "loop.v2-cursor\0v1";
const encryptionKeyDomain = "loop.v2-cursor\0v1\0encryption-key";
const minimumSecretBytes = 32;
const defaultTtlSeconds = 600;
const minimumTtlSeconds = 1;
const maximumTtlSeconds = 3_600;
const maximumCursorLength = 1_536;
const maximumPayloadBytes = 1_024;
const maximumPlaintextBytes = 512;
const maximumContinuationKeys = 16;
const maximumContinuationStringLength = 256;
const aesGcmIvBytes = 12;
const aesGcmTagBytes = 16;
const sha256Bytes = 32;
const base64UrlPattern = /^[A-Za-z0-9_-]+$/;
const ownerIdPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const routePattern = /^[a-z][A-Za-z0-9]{0,63}$/;
const filterPattern = /^[\x21-\x7e]{0,256}$/;
const continuationKeyPattern = /^[a-z][A-Za-z0-9]{0,31}$/;

export type V2CursorContinuationValue = string | number | boolean;

export type V2CursorContinuation = Readonly<
  Record<string, V2CursorContinuationValue>
>;

export interface V2CursorContext {
  readonly ownerId: string;
  readonly route: string;
  readonly filter: string;
}

export interface EncodeV2CursorInput extends V2CursorContext {
  readonly continuation: V2CursorContinuation;
}

export interface DecodeV2CursorInput extends V2CursorContext {
  readonly cursor: string;
}

export interface CreateV2CursorCodecInput {
  readonly secret: Uint8Array;
  readonly ttlSeconds?: number;
  readonly now?: () => Date;
}

export interface V2CursorCodec {
  encode(input: EncodeV2CursorInput): string;
  decode(input: DecodeV2CursorInput): V2CursorContinuation;
}

export class InvalidV2CursorError extends Error {
  readonly code = "invalid_v2_cursor";

  constructor() {
    super("The V2 cursor is invalid or expired");
    this.name = "InvalidV2CursorError";
  }
}

interface CursorKeys {
  readonly hmac: KeyObject;
  readonly encryption: KeyObject;
}

interface CursorHeader {
  readonly v: 1;
  readonly expires: number;
}

interface CursorEnvelope extends CursorHeader {
  readonly iv: string;
  readonly ciphertext: string;
  readonly tag: string;
}

function invalidCursor(): never {
  throw new InvalidV2CursorError();
}

function createCursorKeys(secret: Uint8Array): CursorKeys {
  if (
    !(secret instanceof Uint8Array) ||
    secret.byteLength < minimumSecretBytes
  ) {
    throw new TypeError("V2 cursor HMAC secret is invalid");
  }
  const secretCopy = Buffer.from(secret);
  let encryptionBytes: Buffer | undefined;
  try {
    encryptionBytes = createHmac("sha256", secretCopy)
      .update(encryptionKeyDomain, "utf8")
      .digest();
    return Object.freeze({
      hmac: createSecretKey(secretCopy),
      encryption: createSecretKey(encryptionBytes),
    });
  } finally {
    secretCopy.fill(0);
    encryptionBytes?.fill(0);
  }
}

function validateTtlSeconds(value: number): number {
  if (
    !Number.isInteger(value) ||
    value < minimumTtlSeconds ||
    value > maximumTtlSeconds
  ) {
    throw new TypeError("V2 cursor TTL is invalid");
  }
  return value;
}

function readEpochSeconds(now: () => Date): number {
  const milliseconds = now().getTime();
  if (!Number.isFinite(milliseconds) || milliseconds < 0) {
    return invalidCursor();
  }
  return Math.floor(milliseconds / 1_000);
}

function validateContext(context: V2CursorContext): void {
  if (
    typeof context.ownerId !== "string" ||
    !ownerIdPattern.test(context.ownerId) ||
    typeof context.route !== "string" ||
    !routePattern.test(context.route) ||
    typeof context.filter !== "string" ||
    !filterPattern.test(context.filter)
  ) {
    return invalidCursor();
  }
}

function canonicalContinuation(value: unknown): {
  readonly continuation: V2CursorContinuation;
  readonly json: string;
} {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return invalidCursor();
  }
  const keys = Object.keys(value).sort();
  if (keys.length < 1 || keys.length > maximumContinuationKeys) {
    return invalidCursor();
  }
  const record = value as Record<string, unknown>;
  const continuation: Record<string, V2CursorContinuationValue> = {};
  for (const key of keys) {
    const entry = record[key];
    if (
      !continuationKeyPattern.test(key) ||
      (typeof entry === "string" &&
        entry.length > maximumContinuationStringLength) ||
      (typeof entry === "number" && !Number.isSafeInteger(entry)) ||
      (typeof entry !== "string" &&
        typeof entry !== "number" &&
        typeof entry !== "boolean")
    ) {
      return invalidCursor();
    }
    continuation[key] = entry;
  }
  return {
    continuation: Object.freeze(continuation),
    json: JSON.stringify(continuation, keys),
  };
}

function canonicalEnvelope(envelope: CursorEnvelope): string {
  return JSON.stringify({
    v: envelope.v,
    expires: envelope.expires,
    iv: envelope.iv,
    ciphertext: envelope.ciphertext,
    tag: envelope.tag,
  });
}

function associatedData(
  context: V2CursorContext,
  header: CursorHeader,
): Buffer {
  return Buffer.from(
    `${hmacDomain}\0owner\0${context.ownerId}\0route\0${context.route}\0filter\0${context.filter}\0expires\0${header.expires}`,
    "utf8",
  );
}

function cursorMac(
  key: KeyObject,
  context: V2CursorContext,
  payload: Uint8Array,
): Buffer {
  return createHmac("sha256", key)
    .update(hmacDomain, "utf8")
    .update("\0owner\0", "utf8")
    .update(context.ownerId, "utf8")
    .update("\0route\0", "utf8")
    .update(context.route, "utf8")
    .update("\0filter\0", "utf8")
    .update(context.filter, "utf8")
    .update("\0payload\0", "utf8")
    .update(payload)
    .digest();
}

function decodeBase64Url(
  value: string,
  maximumBytes: number,
  exactBytes?: number,
): Buffer {
  if (
    value.length < 1 ||
    !base64UrlPattern.test(value) ||
    value.length > Math.ceil((maximumBytes * 4) / 3)
  ) {
    return invalidCursor();
  }
  const decoded = Buffer.from(value, "base64url");
  if (
    decoded.length < 1 ||
    decoded.length > maximumBytes ||
    (exactBytes !== undefined && decoded.length !== exactBytes) ||
    decoded.toString("base64url") !== value
  ) {
    decoded.fill(0);
    return invalidCursor();
  }
  return decoded;
}

function parseEnvelope(payload: Buffer): CursorEnvelope {
  let json: string;
  try {
    json = new TextDecoder("utf-8", { fatal: true }).decode(payload);
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
  const record = value as Record<string, unknown>;
  if (
    Object.keys(record).join(",") !== "v,expires,iv,ciphertext,tag" ||
    record["v"] !== 1 ||
    typeof record["expires"] !== "number" ||
    !Number.isSafeInteger(record["expires"]) ||
    record["expires"] < 1 ||
    typeof record["iv"] !== "string" ||
    typeof record["ciphertext"] !== "string" ||
    typeof record["tag"] !== "string"
  ) {
    return invalidCursor();
  }
  const envelope: CursorEnvelope = {
    v: 1,
    expires: record["expires"],
    iv: record["iv"],
    ciphertext: record["ciphertext"],
    tag: record["tag"],
  };
  if (canonicalEnvelope(envelope) !== json) {
    return invalidCursor();
  }
  return envelope;
}

export function createV2CursorCodec(
  input: CreateV2CursorCodecInput,
): V2CursorCodec {
  const keys = createCursorKeys(input.secret);
  const ttlSeconds = validateTtlSeconds(input.ttlSeconds ?? defaultTtlSeconds);
  const now = input.now ?? (() => new Date());

  return Object.freeze({
    encode(request: EncodeV2CursorInput): string {
      validateContext(request);
      const { json } = canonicalContinuation(request.continuation);
      const plaintext = Buffer.from(json, "utf8");
      if (plaintext.length > maximumPlaintextBytes) {
        plaintext.fill(0);
        return invalidCursor();
      }
      const header: CursorHeader = {
        v: 1,
        expires: readEpochSeconds(now) + ttlSeconds,
      };
      const iv = randomBytes(aesGcmIvBytes);
      const aad = associatedData(request, header);
      try {
        const cipher = createCipheriv("aes-256-gcm", keys.encryption, iv, {
          authTagLength: aesGcmTagBytes,
        });
        cipher.setAAD(aad, { plaintextLength: plaintext.length });
        const ciphertext = Buffer.concat([
          cipher.update(plaintext),
          cipher.final(),
        ]);
        const envelope: CursorEnvelope = {
          ...header,
          iv: iv.toString("base64url"),
          ciphertext: ciphertext.toString("base64url"),
          tag: cipher.getAuthTag().toString("base64url"),
        };
        const payload = Buffer.from(canonicalEnvelope(envelope), "utf8");
        if (payload.length > maximumPayloadBytes) {
          return invalidCursor();
        }
        const mac = cursorMac(keys.hmac, request, payload);
        const cursor = `${payload.toString("base64url")}.${mac.toString("base64url")}`;
        if (cursor.length > maximumCursorLength) {
          return invalidCursor();
        }
        return cursor;
      } finally {
        plaintext.fill(0);
        iv.fill(0);
        aad.fill(0);
      }
    },

    decode(request: DecodeV2CursorInput): V2CursorContinuation {
      validateContext(request);
      if (
        typeof request.cursor !== "string" ||
        request.cursor.length < 3 ||
        request.cursor.length > maximumCursorLength
      ) {
        return invalidCursor();
      }
      const parts = request.cursor.split(".");
      const payloadPart = parts[0];
      const macPart = parts[1];
      if (
        parts.length !== 2 ||
        payloadPart === undefined ||
        macPart === undefined
      ) {
        return invalidCursor();
      }
      const payload = decodeBase64Url(payloadPart, maximumPayloadBytes);
      const providedMac = decodeBase64Url(macPart, sha256Bytes, sha256Bytes);
      const expectedMac = cursorMac(keys.hmac, request, payload);
      try {
        if (!timingSafeEqual(providedMac, expectedMac)) {
          return invalidCursor();
        }
        const envelope = parseEnvelope(payload);
        if (envelope.expires <= readEpochSeconds(now)) {
          return invalidCursor();
        }
        const iv = decodeBase64Url(envelope.iv, aesGcmIvBytes, aesGcmIvBytes);
        const ciphertext = decodeBase64Url(
          envelope.ciphertext,
          maximumPlaintextBytes,
        );
        const tag = decodeBase64Url(
          envelope.tag,
          aesGcmTagBytes,
          aesGcmTagBytes,
        );
        const aad = associatedData(request, envelope);
        let plaintext: Buffer | undefined;
        try {
          const decipher = createDecipheriv(
            "aes-256-gcm",
            keys.encryption,
            iv,
            { authTagLength: aesGcmTagBytes },
          );
          decipher.setAAD(aad, { plaintextLength: ciphertext.length });
          decipher.setAuthTag(tag);
          plaintext = Buffer.concat([
            decipher.update(ciphertext),
            decipher.final(),
          ]);
          const json = plaintext.toString("utf8");
          const canonical = canonicalContinuation(JSON.parse(json));
          if (canonical.json !== json) {
            return invalidCursor();
          }
          return canonical.continuation;
        } catch (error) {
          if (error instanceof InvalidV2CursorError) {
            throw error;
          }
          return invalidCursor();
        } finally {
          iv.fill(0);
          ciphertext.fill(0);
          tag.fill(0);
          aad.fill(0);
          plaintext?.fill(0);
        }
      } finally {
        payload.fill(0);
        providedMac.fill(0);
        expectedMac.fill(0);
      }
    },
  });
}
