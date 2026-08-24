export type StreamTokenProduct = "chat" | "video";

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

export function createUnavailableStreamTokenIssuer(): StreamTokenIssuer {
  return Object.freeze({ issueToken: unavailable });
}
