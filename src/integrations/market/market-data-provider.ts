import type { MarketSource } from "../../features/market/market-contract.js";

/**
 * Market Provider boundary (Decision 0034).
 *
 * Each adapter talks to exactly one official Provider, keeps within that
 * Provider's published rate limit through a client-side throttle, records the
 * SHA-256 digest of every raw response it accepted, and returns only the
 * normalised projection below. Amounts are canonical decimal strings taken
 * losslessly from the response text; a JSON number is never turned into a
 * JavaScript number on the way through.
 *
 * Errors carry a stable reason code and never the Provider URL, headers, or
 * response body.
 */

export type MarketProviderErrorCode =
  | "market_provider_disabled"
  | "market_provider_rate_limited"
  | "market_provider_unreachable"
  | "market_provider_rejected"
  | "market_provider_malformed";

export class MarketProviderError extends Error {
  constructor(
    readonly code: MarketProviderErrorCode,
    readonly reasonCode: string,
  ) {
    super(`Market Provider request failed (${code})`);
    this.name = "MarketProviderError";
  }
}

export interface ProviderObservation<T> {
  readonly value: T;
  readonly source: MarketSource;
  readonly fetchedAt: string;
  /** SHA-256 hex digest of the raw response body. */
  readonly rawDigest: string;
}

export interface ProviderReadOptions {
  readonly signal?: AbortSignal;
}

/** One DEX pair for a token as DexScreener reports it. */
export interface TokenPairSnapshot {
  readonly pairAddress: string;
  readonly dexId: string;
  readonly labels: readonly string[];
  readonly baseTokenAddress: string;
  readonly baseTokenSymbol: string;
  readonly quoteTokenAddress: string;
  readonly quoteTokenSymbol: string;
  readonly priceUsd: string | null;
  readonly priceNative: string | null;
  readonly liquidityUsd: string | null;
  readonly volumeH24: string | null;
  readonly priceChangeH24: string | null;
  readonly fdv: string | null;
  readonly marketCap: string | null;
  readonly buysH24: number | null;
  readonly sellsH24: number | null;
  readonly pairCreatedAt: string | null;
}

export interface TokenPairsSnapshot {
  readonly tokenAddress: string;
  readonly pairs: readonly TokenPairSnapshot[];
}

export interface MarketPairsProvider {
  readonly source: MarketSource;
  readTokenPairs(
    tokenAddress: string,
    options?: ProviderReadOptions,
  ): Promise<ProviderObservation<TokenPairsSnapshot>>;
}

/**
 * A single security fact. `value` is a canonical string (`true`/`false` for
 * flags, a decimal string for taxes); the client renders it as a labelled fact
 * with its source and observation time and never turns it into a score.
 */
export interface TokenSecurityFact {
  readonly fact: string;
  readonly value: string;
}

export interface TokenSecuritySnapshot {
  readonly tokenAddress: string;
  readonly facts: readonly TokenSecurityFact[];
  readonly holderCount: string | null;
}

export interface SecurityFactsProvider {
  readonly source: MarketSource;
  readTokenSecurity(
    tokenAddress: string,
    options?: ProviderReadOptions,
  ): Promise<ProviderObservation<TokenSecuritySnapshot>>;
}

export interface OhlcvCandle {
  readonly openTime: string;
  readonly open: string;
  readonly high: string;
  readonly low: string;
  readonly close: string;
  readonly volume: string;
}

export interface PoolOhlcvSnapshot {
  readonly poolAddress: string;
  readonly candles: readonly OhlcvCandle[];
}

export interface NewPoolSnapshot {
  readonly poolAddress: string;
  readonly dexId: string;
  readonly name: string;
  readonly baseTokenAddress: string | null;
  readonly quoteTokenAddress: string | null;
  readonly createdAt: string | null;
  readonly reserveUsd: string | null;
  readonly volumeH24Usd: string | null;
}

export interface NewPoolsSnapshot {
  readonly pools: readonly NewPoolSnapshot[];
}

export interface PoolTradeSnapshot {
  readonly transactionHash: string;
  readonly blockNumber: string;
  readonly blockTimestamp: string;
  readonly kind: "buy" | "sell";
  readonly fromTokenAmount: string;
  readonly toTokenAmount: string;
  readonly priceFromInUsd: string | null;
  readonly priceToInUsd: string | null;
  readonly volumeUsd: string | null;
}

export interface PoolTradesSnapshot {
  readonly poolAddress: string;
  readonly trades: readonly PoolTradeSnapshot[];
}

export type OhlcvTimeframe = "15m" | "1h" | "4h" | "1d" | "1w";

export interface OhlcvReadOptions extends ProviderReadOptions {
  /** Token whose price the candles express (in USD); the pool's base by default. */
  readonly tokenAddress?: string;
}

export interface CandlesProvider {
  readonly source: MarketSource;
  readPoolOhlcv(
    poolAddress: string,
    timeframe: OhlcvTimeframe,
    limit: number,
    options?: OhlcvReadOptions,
  ): Promise<ProviderObservation<PoolOhlcvSnapshot>>;
  readNewPools(
    options?: ProviderReadOptions,
  ): Promise<ProviderObservation<NewPoolsSnapshot>>;
  readPoolTrades(
    poolAddress: string,
    options?: ProviderReadOptions,
  ): Promise<ProviderObservation<PoolTradesSnapshot>>;
}

function disabled(reasonCode: string): () => Promise<never> {
  return () =>
    Promise.reject(
      new MarketProviderError("market_provider_disabled", reasonCode),
    );
}

export function createUnavailableMarketPairsProvider(
  reasonCode: string,
  source: MarketSource = "dexscreener",
): MarketPairsProvider {
  return Object.freeze({ source, readTokenPairs: disabled(reasonCode) });
}

export function createUnavailableSecurityFactsProvider(
  reasonCode: string,
  source: MarketSource = "goplus",
): SecurityFactsProvider {
  return Object.freeze({ source, readTokenSecurity: disabled(reasonCode) });
}

export function createUnavailableCandlesProvider(
  reasonCode: string,
  source: MarketSource = "geckoterminal",
): CandlesProvider {
  return Object.freeze({
    source,
    readPoolOhlcv: disabled(reasonCode),
    readNewPools: disabled(reasonCode),
    readPoolTrades: disabled(reasonCode),
  });
}
