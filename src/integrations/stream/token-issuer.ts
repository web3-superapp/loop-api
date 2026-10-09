import { StreamClient } from "@stream-io/node-sdk";

import type { StreamConfig } from "../../config.js";

export type StreamTokenProduct = "chat" | "video";

const requiredTokenTtlSeconds = 60 * 60;
const streamUserIdPattern = /^loop_[a-z0-9_-]{8,58}$/;
const supportedProducts: ReadonlySet<string> = new Set(["chat", "video"]);

export interface IssueStreamProviderTokenInput {
  readonly product: StreamTokenProduct;
  readonly streamUserId: string;
  readonly issuedAtEpochSeconds: number;
  readonly expiresAtEpochSeconds: number;
  readonly signal: AbortSignal;
}

export interface IssuedStreamProviderToken {
  readonly apiKey: string;
  readonly token: string;
}

export interface StreamTokenIssuer {
  issueToken(
    input: IssueStreamProviderTokenInput,
  ): Promise<IssuedStreamProviderToken>;
}

export class StreamTokenIssuerUnavailableError extends Error {
  constructor() {
    super("Stream token issuer is unavailable");
    this.name = "StreamTokenIssuerUnavailableError";
  }
}

function unavailable(): Promise<never> {
  return Promise.reject(new StreamTokenIssuerUnavailableError());
}

function hasValidIssuanceInput(input: IssueStreamProviderTokenInput): boolean {
  return (
    supportedProducts.has(input.product) &&
    typeof input.streamUserId === "string" &&
    streamUserIdPattern.test(input.streamUserId) &&
    Number.isSafeInteger(input.issuedAtEpochSeconds) &&
    input.issuedAtEpochSeconds > 0 &&
    Number.isSafeInteger(input.expiresAtEpochSeconds) &&
    input.expiresAtEpochSeconds ===
      input.issuedAtEpochSeconds + requiredTokenTtlSeconds
  );
}

export function createUnavailableStreamTokenIssuer(): StreamTokenIssuer {
  return Object.freeze({ issueToken: unavailable });
}

export function createStreamTokenIssuer(
  config: StreamConfig,
): StreamTokenIssuer {
  const apiKey = config.apiKey;
  const client = new StreamClient(apiKey, config.apiSecret);

  return Object.freeze({
    async issueToken(
      input: IssueStreamProviderTokenInput,
    ): Promise<IssuedStreamProviderToken> {
      input.signal.throwIfAborted();

      if (!hasValidIssuanceInput(input)) {
        throw new Error("Invalid Stream token issuance input");
      }

      const token = await Promise.resolve(
        client.generateUserToken({
          user_id: input.streamUserId,
          iat: input.issuedAtEpochSeconds,
          exp: input.expiresAtEpochSeconds,
        }),
      );
      input.signal.throwIfAborted();

      return Object.freeze({ apiKey, token });
    },
  });
}
