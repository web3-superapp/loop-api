export type HyperliquidPrivateReadKind =
  "config" | "account" | "positions" | "orders" | "fills" | "funding";

export type HyperliquidPrivateListReadKind = Exclude<
  HyperliquidPrivateReadKind,
  "config" | "account"
>;

interface HyperliquidPrivateReadBaseInput {
  readonly network: "testnet";
  readonly dex: "";
  readonly accountAddress: string;
  readonly transportAttemptId: string;
  readonly signal: AbortSignal;
}

export type HyperliquidPrivateReadInput =
  | (HyperliquidPrivateReadBaseInput & {
      readonly kind: "config" | "account";
      readonly limit?: never;
      readonly providerCursorState?: never;
    })
  | (HyperliquidPrivateReadBaseInput & {
      readonly kind: HyperliquidPrivateListReadKind;
      readonly limit?: number;
      readonly providerCursorState?: string;
    });

/**
 * Provider output remains unknown until the feature service validates the
 * exact response shape and every decimal string.
 */
export interface HyperliquidPrivateReader {
  read(input: HyperliquidPrivateReadInput): Promise<unknown>;
}

export type RetryableHyperliquidReadReason =
  "pre_response_transport" | "provider_5xx";
const retryableReadReasons: ReadonlySet<string> = new Set([
  "pre_response_transport",
  "provider_5xx",
]);

export class RetryableHyperliquidReadError extends Error {
  readonly code = "retryable_hyperliquid_read";
  readonly reason: RetryableHyperliquidReadReason;

  constructor(reason: RetryableHyperliquidReadReason) {
    if (!retryableReadReasons.has(reason)) {
      throw new TypeError("Hyperliquid read retry reason is invalid");
    }

    super("The Hyperliquid private read may be retried");
    this.name = "RetryableHyperliquidReadError";
    this.reason = reason;
  }
}

export class HyperliquidPrivateReaderUnavailableError extends Error {
  readonly code = "hyperliquid_private_reader_unavailable";

  constructor() {
    super("Hyperliquid private reads are unavailable");
    this.name = "HyperliquidPrivateReaderUnavailableError";
  }
}

function unavailable(): Promise<never> {
  return Promise.reject(new HyperliquidPrivateReaderUnavailableError());
}

export function createUnavailableHyperliquidPrivateReader(): HyperliquidPrivateReader {
  return Object.freeze({ read: unavailable });
}
