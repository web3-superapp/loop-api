import {
  createCipheriv,
  createDecipheriv,
  createHmac,
  createSecretKey,
  randomBytes,
  timingSafeEqual,
  type KeyObject,
} from "node:crypto";

const hmacDomain = "loop.social-cursor\0v1";
const encryptionKeyDomain = "loop.social-cursor\0v1\0encryption-key";
const minimumSecretBytes = 32;
const defaultTtlSeconds = 600;
const maximumCursorLength = 1_024;
const maximumPayloadBytes = 768;
const maximumPlaintextBytes = 256;
const aesGcmIvBytes = 12;
const aesGcmTagBytes = 16;
const sha256Bytes = 32;
const base64UrlPattern = /^[A-Za-z0-9_-]+$/;
const uuidPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const routes = new Set(["friends", "friend_requests"]);
const filters = new Set([
  "accepted",
  "direction=incoming&status=pending",
  "direction=outgoing&status=pending",
]);

export type SocialCursorRoute = "friends" | "friend_requests";

export interface EncodeSocialCursorInput {
  readonly ownerUserId: string;
  readonly route: SocialCursorRoute;
  readonly filter: string;
  readonly limit: number;
  readonly lastAt: string;
  readonly lastId: string;
}

export interface DecodeSocialCursorInput {
  readonly cursor: string;
  readonly ownerUserId: string;
  readonly route: SocialCursorRoute;
  readonly filter: string;
}

export interface DecodedSocialCursor {
  readonly limit: number;
  readonly lastAt: string;
  readonly lastId: string;
}

export interface SocialCursorCodec {
  encode(input: EncodeSocialCursorInput): string;
  decode(input: DecodeSocialCursorInput): DecodedSocialCursor;
}

export class InvalidSocialCursorError extends Error {
  readonly code = "invalid_social_cursor";

  constructor() {
    super("The social cursor is invalid or expired");
    this.name = "InvalidSocialCursorError";
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
  throw new InvalidSocialCursorError();
}

function createCursorKeys(secret: Uint8Array): CursorKeys {
  if (
    !(secret instanceof Uint8Array) ||
    secret.byteLength < minimumSecretBytes
  ) {
    throw new TypeError("Social cursor HMAC secret is invalid");
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

function readEpochSeconds(now: () => Date): number {
  const milliseconds = now().getTime();
  if (!Number.isFinite(milliseconds) || milliseconds < 0) {
    return invalidCursor();
  }
  return Math.floor(milliseconds / 1_000);
}

function validateContext(input: {
  readonly ownerUserId: string;
  readonly route: SocialCursorRoute;
  readonly filter: string;
}): void {
  if (
    !uuidPattern.test(input.ownerUserId) ||
    !routes.has(input.route) ||
    !filters.has(input.filter) ||
    (input.route === "friends") !== (input.filter === "accepted")
  ) {
    return invalidCursor();
  }
}

function validateContinuation(input: DecodedSocialCursor): DecodedSocialCursor {
  const parsedAt = Date.parse(input.lastAt);
  if (
    !Number.isInteger(input.limit) ||
    input.limit < 1 ||
    input.limit > 50 ||
    !Number.isFinite(parsedAt) ||
    new Date(parsedAt).toISOString() !== input.lastAt ||
    !uuidPattern.test(input.lastId)
  ) {
    return invalidCursor();
  }
  return Object.freeze({
    limit: input.limit,
    lastAt: input.lastAt,
    lastId: input.lastId,
  });
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
  context: {
    readonly ownerUserId: string;
    readonly route: SocialCursorRoute;
    readonly filter: string;
  },
  header: CursorHeader,
): Buffer {
  return Buffer.from(
    `${hmacDomain}\0owner\0${context.ownerUserId}\0route\0${context.route}\0filter\0${context.filter}\0expires\0${header.expires}`,
    "utf8",
  );
}

function cursorMac(
  key: KeyObject,
  context: {
    readonly ownerUserId: string;
    readonly route: SocialCursorRoute;
    readonly filter: string;
  },
  payload: Uint8Array,
): Buffer {
  return createHmac("sha256", key)
    .update(hmacDomain, "utf8")
    .update("\0owner\0", "utf8")
    .update(context.ownerUserId, "utf8")
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
  let decoded: Buffer;
  try {
    decoded = Buffer.from(value, "base64url");
  } catch {
    return invalidCursor();
  }
  if (
    decoded.length < 1 ||
    decoded.length > maximumBytes ||
    decoded.toString("base64url") !== value ||
    (exactBytes !== undefined && decoded.length !== exactBytes)
  ) {
    decoded.fill(0);
    return invalidCursor();
  }
  return decoded;
}

function parseEnvelope(payload: Buffer): CursorEnvelope {
  let value: unknown;
  try {
    value = JSON.parse(payload.toString("utf8"));
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
    !Number.isSafeInteger(record["expires"]) ||
    typeof record["iv"] !== "string" ||
    typeof record["ciphertext"] !== "string" ||
    typeof record["tag"] !== "string"
  ) {
    return invalidCursor();
  }
  return {
    v: 1,
    expires: record["expires"] as number,
    iv: record["iv"],
    ciphertext: record["ciphertext"],
    tag: record["tag"],
  };
}

export function createSocialCursorCodec(input: {
  readonly secret: Uint8Array;
  readonly ttlSeconds?: number;
  readonly now?: () => Date;
}): SocialCursorCodec {
  const ttlSeconds = input.ttlSeconds ?? defaultTtlSeconds;
  if (!Number.isInteger(ttlSeconds) || ttlSeconds < 1 || ttlSeconds > 3_600) {
    throw new TypeError("Social cursor TTL is invalid");
  }
  const keys = createCursorKeys(input.secret);
  const now = input.now ?? (() => new Date());

  return Object.freeze({
    encode(request: EncodeSocialCursorInput): string {
      validateContext(request);
      const continuation = validateContinuation(request);
      const header: CursorHeader = {
        v: 1,
        expires: readEpochSeconds(now) + ttlSeconds,
      };
      const plaintext = Buffer.from(
        JSON.stringify({
          limit: continuation.limit,
          last_at: continuation.lastAt,
          last_id: continuation.lastId,
        }),
        "utf8",
      );
      if (plaintext.length > maximumPlaintextBytes) {
        plaintext.fill(0);
        return invalidCursor();
      }
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

    decode(request: DecodeSocialCursorInput): DecodedSocialCursor {
      validateContext(request);
      if (
        typeof request.cursor !== "string" ||
        request.cursor.length < 3 ||
        request.cursor.length > maximumCursorLength
      ) {
        return invalidCursor();
      }
      const parts = request.cursor.split(".");
      if (
        parts.length !== 2 ||
        parts[0] === undefined ||
        parts[1] === undefined
      ) {
        return invalidCursor();
      }
      const payload = decodeBase64Url(parts[0], maximumPayloadBytes);
      const providedMac = decodeBase64Url(parts[1], sha256Bytes, sha256Bytes);
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
          const decoded = JSON.parse(plaintext.toString("utf8")) as unknown;
          if (
            typeof decoded !== "object" ||
            decoded === null ||
            Array.isArray(decoded)
          ) {
            return invalidCursor();
          }
          const record = decoded as Record<string, unknown>;
          if (
            Object.keys(record).join(",") !== "limit,last_at,last_id" ||
            typeof record["last_at"] !== "string" ||
            typeof record["last_id"] !== "string"
          ) {
            return invalidCursor();
          }
          return validateContinuation({
            limit: record["limit"] as number,
            lastAt: record["last_at"],
            lastId: record["last_id"],
          });
        } catch (error) {
          if (error instanceof InvalidSocialCursorError) {
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
