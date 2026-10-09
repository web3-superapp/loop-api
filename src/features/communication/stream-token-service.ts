import { createHmac, createSecretKey, type KeyObject } from "node:crypto";
import { isIP } from "node:net";

import type { AuthenticatedLoopPrincipal } from "../../core/http/authentication.js";
import {
  ControlPlaneUnavailableError,
  IssuanceQuotaExceededError,
  type ControlPlaneRepository,
} from "../../database/control-plane-repository.js";
import { deriveStreamUserId } from "../identity/loop-identifiers.js";
import {
  StreamTokenIssuerUnavailableError,
  type IssuedStreamProviderToken,
  type StreamTokenIssuer,
  type StreamTokenProduct,
} from "../../integrations/stream/token-issuer.js";

const policyVersionPattern = /^[a-z][a-z0-9_]{0,63}$/;
const streamUserIdPattern = /^loop_[a-z0-9_-]{8,58}$/;
const printableApiKeyPattern = /^[\x21-\x7e]{1,512}$/;
const printableTokenPattern = /^[\x21-\x7e]{32,16384}$/;
const hmacDomain = "loop.stream-token-quota\0v1";
const minimumHmacSecretBytes = 32;
const supportedProducts: ReadonlySet<string> = new Set(["chat", "video"]);

export const STREAM_TOKEN_TTL_SECONDS = 3_600;

export const STREAM_TOKEN_CAPABILITIES = Object.freeze({
  chat: "stream_chat_token",
  video: "stream_video_token",
} as const satisfies Readonly<Record<StreamTokenProduct, string>>);

export interface StreamTokenQuotaRule {
  readonly capacity: number;
  readonly windowDurationSeconds: number;
}

export interface StreamTokenProductQuotaPolicy {
  readonly user: StreamTokenQuotaRule;
  readonly ip: StreamTokenQuotaRule;
}

export interface StreamTokenIssuancePolicy {
  readonly policyVersion: string;
  readonly quotaByProduct: Readonly<
    Record<StreamTokenProduct, StreamTokenProductQuotaPolicy>
  >;
}

export type StreamTokenQuotaRepository = Pick<
  ControlPlaneRepository,
  "consumeIssuanceQuota"
>;

export interface CreateStreamTokenServiceInput {
  readonly issuer: StreamTokenIssuer;
  readonly quota: StreamTokenQuotaRepository;
  readonly quotaHmacSecret: Uint8Array;
  readonly policy: StreamTokenIssuancePolicy;
  readonly now?: () => Date;
}

export interface IssueStreamTokenInput {
  readonly principal: AuthenticatedLoopPrincipal;
  readonly product: StreamTokenProduct;
  readonly canonicalClientIp: string;
  readonly signal: AbortSignal;
}

export interface StreamTokenResponse {
  readonly api_key: string;
  readonly token: string;
  readonly expires_at: string;
  readonly user: {
    readonly id: string;
  };
}

export interface StreamTokenService {
  issueToken(input: IssueStreamTokenInput): Promise<StreamTokenResponse>;
}

export class InvalidStreamTokenRequestError extends Error {
  readonly code = "invalid_stream_token_request";

  constructor() {
    super("The Stream token request is invalid");
    this.name = "InvalidStreamTokenRequestError";
  }
}

export class StreamTokenQuotaExceededError extends Error {
  readonly code = "stream_token_quota_exceeded";

  constructor() {
    super("Stream token issuance quota exceeded");
    this.name = "StreamTokenQuotaExceededError";
  }
}

export class StreamTokenUnavailableError extends Error {
  readonly code = "stream_token_unavailable";

  constructor() {
    super("Stream token issuance is unavailable");
    this.name = "StreamTokenUnavailableError";
  }
}

export class StreamTokenIssuanceFailedError extends Error {
  readonly code = "stream_token_issuance_failed";

  constructor() {
    super("Stream token issuance failed");
    this.name = "StreamTokenIssuanceFailedError";
  }
}

function assertQuotaRule(rule: StreamTokenQuotaRule): void {
  if (
    !Number.isInteger(rule.capacity) ||
    rule.capacity < 1 ||
    rule.capacity > 100_000 ||
    !Number.isInteger(rule.windowDurationSeconds) ||
    rule.windowDurationSeconds < 1 ||
    rule.windowDurationSeconds > 86_400
  ) {
    throw new TypeError("Stream token quota policy is invalid");
  }
}

function copyAndValidatePolicy(
  policy: StreamTokenIssuancePolicy,
): StreamTokenIssuancePolicy {
  if (!policyVersionPattern.test(policy.policyVersion)) {
    throw new TypeError("Stream token quota policy version is invalid");
  }

  for (const product of ["chat", "video"] as const) {
    assertQuotaRule(policy.quotaByProduct[product].user);
    assertQuotaRule(policy.quotaByProduct[product].ip);
  }

  return Object.freeze({
    policyVersion: policy.policyVersion,
    quotaByProduct: Object.freeze({
      chat: Object.freeze({
        user: Object.freeze({ ...policy.quotaByProduct.chat.user }),
        ip: Object.freeze({ ...policy.quotaByProduct.chat.ip }),
      }),
      video: Object.freeze({
        user: Object.freeze({ ...policy.quotaByProduct.video.user }),
        ip: Object.freeze({ ...policy.quotaByProduct.video.ip }),
      }),
    }),
  });
}

function createQuotaHmacKey(secret: Uint8Array): KeyObject {
  if (secret.byteLength < minimumHmacSecretBytes) {
    throw new TypeError("Stream token quota HMAC secret is invalid");
  }

  const secretCopy = Buffer.from(secret);

  try {
    return createSecretKey(secretCopy);
  } finally {
    secretCopy.fill(0);
  }
}

function isCanonicalIp(value: string): boolean {
  const family = isIP(value);

  if (family === 0) {
    return false;
  }

  try {
    const url =
      family === 6
        ? new URL(`http://[${value}]/`)
        : new URL(`http://${value}/`);
    const canonical = family === 6 ? url.hostname.slice(1, -1) : url.hostname;
    return value === canonical;
  } catch {
    return false;
  }
}

function assertRequest(input: IssueStreamTokenInput): void {
  if (!supportedProducts.has(input.product)) {
    throw new InvalidStreamTokenRequestError();
  }

  let expectedStreamUserId: string;

  try {
    expectedStreamUserId = deriveStreamUserId(input.principal.userId);
  } catch {
    throw new InvalidStreamTokenRequestError();
  }

  if (
    typeof input.principal.streamUserId !== "string" ||
    !streamUserIdPattern.test(input.principal.streamUserId) ||
    input.principal.streamUserId !== expectedStreamUserId ||
    typeof input.canonicalClientIp !== "string" ||
    !isCanonicalIp(input.canonicalClientIp)
  ) {
    throw new InvalidStreamTokenRequestError();
  }
}

function subjectHmac(
  key: KeyObject,
  capability: string,
  policyVersion: string,
  subjectKind: "user" | "ip",
  subject: string,
): string {
  return createHmac("sha256", key)
    .update(hmacDomain, "utf8")
    .update("\0", "utf8")
    .update(capability, "utf8")
    .update("\0", "utf8")
    .update(policyVersion, "utf8")
    .update("\0", "utf8")
    .update(subjectKind, "utf8")
    .update("\0", "utf8")
    .update(subject, "utf8")
    .digest("hex");
}

function readEpochSeconds(now: () => Date): number {
  const observedAt = now();
  const milliseconds = observedAt.getTime();

  if (!Number.isFinite(milliseconds) || milliseconds < 0) {
    throw new StreamTokenIssuanceFailedError();
  }

  return Math.floor(milliseconds / 1_000);
}

function parseIssuerResult(value: unknown): IssuedStreamProviderToken {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new StreamTokenIssuanceFailedError();
  }

  const ownKeys = Reflect.ownKeys(value);

  if (
    ownKeys.length !== 2 ||
    !ownKeys.includes("apiKey") ||
    !ownKeys.includes("token")
  ) {
    throw new StreamTokenIssuanceFailedError();
  }

  const descriptors = Object.getOwnPropertyDescriptors(value);
  const apiKey = descriptors["apiKey"]?.value as unknown;
  const token = descriptors["token"]?.value as unknown;

  if (
    typeof apiKey !== "string" ||
    !printableApiKeyPattern.test(apiKey) ||
    typeof token !== "string" ||
    !printableTokenPattern.test(token)
  ) {
    throw new StreamTokenIssuanceFailedError();
  }

  return Object.freeze({ apiKey, token });
}

export function createStreamTokenService(
  input: CreateStreamTokenServiceInput,
): StreamTokenService {
  const hmacKey = createQuotaHmacKey(input.quotaHmacSecret);
  const policy = copyAndValidatePolicy(input.policy);
  const now = input.now ?? (() => new Date());

  return Object.freeze({
    async issueToken(
      request: IssueStreamTokenInput,
    ): Promise<StreamTokenResponse> {
      assertRequest(request);
      request.signal.throwIfAborted();

      const capability = STREAM_TOKEN_CAPABILITIES[request.product];
      const quotaPolicy = policy.quotaByProduct[request.product];
      const quotaInput = {
        capability,
        policyVersion: policy.policyVersion,
        buckets: [
          {
            subjectKind: "user",
            subjectHmac: subjectHmac(
              hmacKey,
              capability,
              policy.policyVersion,
              "user",
              request.principal.userId,
            ),
            windowDurationSeconds: quotaPolicy.user.windowDurationSeconds,
            capacity: quotaPolicy.user.capacity,
          },
          {
            subjectKind: "ip",
            subjectHmac: subjectHmac(
              hmacKey,
              capability,
              policy.policyVersion,
              "ip",
              request.canonicalClientIp,
            ),
            windowDurationSeconds: quotaPolicy.ip.windowDurationSeconds,
            capacity: quotaPolicy.ip.capacity,
          },
        ],
      } as const;

      try {
        await input.quota.consumeIssuanceQuota(quotaInput);
      } catch (error) {
        if (request.signal.aborted) {
          request.signal.throwIfAborted();
        }

        if (error instanceof IssuanceQuotaExceededError) {
          throw new StreamTokenQuotaExceededError();
        }

        if (error instanceof ControlPlaneUnavailableError) {
          throw new StreamTokenUnavailableError();
        }

        throw new StreamTokenIssuanceFailedError();
      }

      request.signal.throwIfAborted();

      let issuedAtEpochSeconds: number;

      try {
        issuedAtEpochSeconds = readEpochSeconds(now);
      } catch {
        throw new StreamTokenIssuanceFailedError();
      }

      const expiresAtEpochSeconds =
        issuedAtEpochSeconds + STREAM_TOKEN_TTL_SECONDS;
      let issued: IssuedStreamProviderToken;

      try {
        issued = parseIssuerResult(
          await input.issuer.issueToken({
            product: request.product,
            streamUserId: request.principal.streamUserId,
            issuedAtEpochSeconds,
            expiresAtEpochSeconds,
            signal: request.signal,
          }),
        );
      } catch (error) {
        if (request.signal.aborted) {
          request.signal.throwIfAborted();
        }

        if (error instanceof StreamTokenIssuerUnavailableError) {
          throw new StreamTokenUnavailableError();
        }

        throw new StreamTokenIssuanceFailedError();
      }

      request.signal.throwIfAborted();

      return Object.freeze({
        api_key: issued.apiKey,
        token: issued.token,
        expires_at: new Date(expiresAtEpochSeconds * 1_000).toISOString(),
        user: Object.freeze({ id: request.principal.streamUserId }),
      });
    },
  });
}
