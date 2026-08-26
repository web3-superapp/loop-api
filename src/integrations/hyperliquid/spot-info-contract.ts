export const HYPERLIQUID_SPOT_INFO_WEIGHT = Object.freeze({
  spotMetaAndAssetCtxs: 20,
  l2Book: 2,
  spotClearinghouseState: 2,
  userFees: 20,
} as const);

export const HYPERLIQUID_SPOT_METADATA_TTL_MILLISECONDS = 60_000;
export const HYPERLIQUID_SPOT_PRIVATE_SOURCE_TTL_MILLISECONDS = 2_000;
export const HYPERLIQUID_SPOT_BOOK_MAX_AGE_MILLISECONDS = 2_000;
export const HYPERLIQUID_SPOT_BOOK_MAX_FUTURE_SKEW_MILLISECONDS = 1_000;
export const HYPERLIQUID_TESTNET_USDC_TOKEN_ID =
  "0xeb62eee3685fc4c43992febcd9e75443";

export type RetryableHyperliquidSpotInfoReason =
  "pre_response_transport" | "provider_5xx";

const retryableReasons: ReadonlySet<string> = new Set([
  "pre_response_transport",
  "provider_5xx",
]);

export class RetryableHyperliquidSpotInfoError extends Error {
  readonly code = "retryable_hyperliquid_spot_info";
  readonly reason: RetryableHyperliquidSpotInfoReason;

  constructor(reason: RetryableHyperliquidSpotInfoReason) {
    if (!retryableReasons.has(reason)) {
      throw new TypeError("Hyperliquid Spot Info retry reason is invalid");
    }
    super("The Hyperliquid Spot Info read may be retried");
    this.name = "RetryableHyperliquidSpotInfoError";
    this.reason = reason;
  }
}

export class HyperliquidSpotInfoUnavailableError extends Error {
  readonly code = "hyperliquid_spot_info_unavailable";

  constructor() {
    super("Hyperliquid Spot Info is unavailable");
    this.name = "HyperliquidSpotInfoUnavailableError";
  }
}

export interface HyperliquidSpotMetaAndAssetContextsRequest {
  readonly type: "spotMetaAndAssetCtxs";
}

export interface HyperliquidSpotBookRequest {
  readonly type: "l2Book";
  readonly coin: string;
  readonly nSigFigs: 5;
  readonly mantissa: null;
}

export interface HyperliquidSpotClearinghouseStateRequest {
  readonly type: "spotClearinghouseState";
  readonly user: string;
}

export interface HyperliquidSpotUserFeesRequest {
  readonly type: "userFees";
  readonly user: string;
}

export type HyperliquidSpotInfoRequest =
  | HyperliquidSpotMetaAndAssetContextsRequest
  | HyperliquidSpotBookRequest
  | HyperliquidSpotClearinghouseStateRequest
  | HyperliquidSpotUserFeesRequest;

export interface HyperliquidSpotInfoTransport {
  post(
    request: HyperliquidSpotInfoRequest,
    signal: AbortSignal,
    callId: string,
  ): Promise<unknown>;
}

export interface HyperliquidSpotMarketAllowlistEntry {
  readonly marketId: string;
  readonly baseTokenId: string;
  readonly quoteTokenId: string;
  readonly spotPairIndex: number;
}

export interface HyperliquidSpotTokenMetadata {
  readonly tokenIndex: number;
  readonly tokenId: string;
  readonly symbol: string;
  readonly fullName: string | null;
  readonly sizeDecimals: number;
  readonly weiDecimals: number;
}

export interface HyperliquidSpotMarketContext {
  readonly previousDayPrice: string;
  readonly dayNotionalVolume: string;
  readonly markPrice: string;
  readonly midPrice: string;
  readonly circulatingSupply: string;
  readonly totalSupply: string;
  readonly dayBaseVolume: string;
}

export interface HyperliquidSpotMarketMetadata {
  readonly marketId: string;
  readonly coin: string;
  readonly base: HyperliquidSpotTokenMetadata;
  readonly quote: HyperliquidSpotTokenMetadata;
  readonly spotPairIndex: number;
  readonly exchangeOrderAsset: number;
  readonly context: HyperliquidSpotMarketContext;
}

export interface HyperliquidSpotMetadataSource {
  readonly provider: "hyperliquid";
  readonly network: "testnet";
  readonly dataset: "spotMetaAndAssetCtxs";
  readonly fetchedAt: string;
  readonly expiresAt: string;
}

export interface HyperliquidSpotMetadataSnapshot {
  readonly markets: readonly HyperliquidSpotMarketMetadata[];
  readonly metadataVersion: string;
  readonly source: HyperliquidSpotMetadataSource;
}

export interface HyperliquidSpotBookLevel {
  readonly price: string;
  readonly size: string;
  readonly orderCount: string;
}

export interface HyperliquidSpotBookSource {
  readonly provider: "hyperliquid";
  readonly network: "testnet";
  readonly dataset: "l2Book";
  readonly providerTime: string;
  readonly fetchedAt: string;
  readonly expiresAt: string;
  readonly metadataVersion: string;
}

export interface HyperliquidSpotBookSnapshot {
  readonly marketId: string;
  readonly coin: string;
  readonly bids: readonly HyperliquidSpotBookLevel[];
  readonly asks: readonly HyperliquidSpotBookLevel[];
  readonly bestBid: HyperliquidSpotBookLevel;
  readonly bestAsk: HyperliquidSpotBookLevel;
  readonly source: HyperliquidSpotBookSource;
}

export interface HyperliquidSpotBalanceItem {
  readonly token: HyperliquidSpotTokenMetadata;
  readonly total: string;
  readonly hold: string;
  readonly available: string;
  readonly entryNotional: string;
}

export interface HyperliquidSpotBalancesSource {
  readonly provider: "hyperliquid";
  readonly network: "testnet";
  readonly dataset: "spotClearinghouseState";
  readonly fetchedAt: string;
  readonly expiresAt: string;
  readonly metadataVersion: string;
}

export interface HyperliquidSpotBalancesSnapshot {
  readonly items: readonly HyperliquidSpotBalanceItem[];
  readonly source: HyperliquidSpotBalancesSource;
}

export interface HyperliquidSpotUserFeesSource {
  readonly provider: "hyperliquid";
  readonly network: "testnet";
  readonly dataset: "userFees";
  readonly fetchedAt: string;
  readonly expiresAt: string;
}

/**
 * Account-scoped Spot rates returned directly by Hyperliquid `userFees`.
 * They are not a pair-adjusted or independently derived final fee schedule.
 */
export interface HyperliquidSpotUserFeesSnapshot {
  readonly accountSpotMakerRate: string;
  readonly accountSpotTakerRate: string;
  readonly source: HyperliquidSpotUserFeesSource;
}

export interface HyperliquidSpotInfoReader {
  readMetadata(input: {
    readonly signal: AbortSignal;
  }): Promise<HyperliquidSpotMetadataSnapshot>;
  readBook(input: {
    readonly marketId: string;
    readonly signal: AbortSignal;
  }): Promise<HyperliquidSpotBookSnapshot>;
  readBalances(input: {
    readonly accountAddress: string;
    readonly signal: AbortSignal;
  }): Promise<HyperliquidSpotBalancesSnapshot>;
  readUserFees(input: {
    readonly accountAddress: string;
    readonly signal: AbortSignal;
  }): Promise<HyperliquidSpotUserFeesSnapshot>;
}
