import type { MarketConfig } from "../../config.js";
import {
  MarketFactCacheUnavailableError,
  type MarketFactCacheRecord,
  type MarketFactCacheRepository,
} from "../../database/market-fact-cache-repository.js";
import {
  MarketProviderError,
  type CandlesProvider,
  type MarketPairsProvider,
  type NewPoolsSnapshot,
  type OhlcvTimeframe,
  type PoolOhlcvSnapshot,
  type ProviderObservation,
  type SecurityFactsProvider,
  type TokenPairSnapshot,
  type TokenPairsSnapshot,
  type TokenSecuritySnapshot,
} from "../../integrations/market/market-data-provider.js";
import {
  compareDecimalStrings,
  marketReasonCodes,
  type MarketFactQuality,
  type MarketSource,
} from "./market-contract.js";

/**
 * Provider + cache orchestration (Decision 0034).
 *
 * For one subject the service returns a `CachedFact`: the normalised value,
 * its source, when it was fetched, its TTL, and a quality that says whether
 * the value is inside its TTL (`fresh`), past it but inside the stale grace
 * window because the Provider could not be reached (`stale`), or absent
 * (`unavailable`). A disabled Provider is unavailable regardless of cache:
 * an operator who turns a Provider off does not keep publishing its numbers.
 */

export interface CachedFact<T> {
  readonly value: T | null;
  readonly source: MarketSource;
  readonly fetchedAt: string | null;
  readonly ttlSeconds: number;
  readonly quality: MarketFactQuality;
  readonly reasonCode: string | null;
  readonly rawDigest: string | null;
}

export interface ReadFactOptions {
  /** When true only a fresh Provider read or fresh cache row is accepted. */
  readonly requireFresh?: boolean;
  readonly signal?: AbortSignal;
}

export interface MarketFactService {
  readTokenPairs(
    tokenAddress: string,
    options?: ReadFactOptions,
  ): Promise<CachedFact<TokenPairsSnapshot>>;
  readTokenSecurity(
    tokenAddress: string,
    options?: ReadFactOptions,
  ): Promise<CachedFact<TokenSecuritySnapshot>>;
  readPoolOhlcv(
    input: {
      readonly poolAddress: string;
      readonly timeframe: OhlcvTimeframe;
      readonly limit: number;
      readonly tokenAddress: string;
    },
    options?: ReadFactOptions,
  ): Promise<CachedFact<PoolOhlcvSnapshot>>;
  readNewPools(
    options?: ReadFactOptions,
  ): Promise<CachedFact<NewPoolsSnapshot>>;
  readonly candlesProviderEnabled: boolean;
}

export interface CreateMarketFactServiceInput {
  readonly config: MarketConfig;
  readonly cache: MarketFactCacheRepository;
  readonly pairsProvider: MarketPairsProvider | null;
  readonly securityProvider: SecurityFactsProvider | null;
  readonly candlesProvider: CandlesProvider | null;
  readonly now?: () => Date;
}

export const marketFactKinds = Object.freeze({
  tokenPairs: "token_pairs",
  tokenSecurity: "token_security",
  poolOhlcv: "pool_ohlcv",
  newPools: "new_pools",
} as const);

function unavailableFact<T>(
  source: MarketSource,
  ttlSeconds: number,
  reasonCode: string,
): CachedFact<T> {
  return Object.freeze({
    value: null,
    source,
    fetchedAt: null,
    ttlSeconds,
    quality: "unavailable",
    reasonCode,
    rawDigest: null,
  });
}

function providerReasonCode(error: unknown): string {
  if (error instanceof MarketProviderError) {
    return error.reasonCode;
  }
  return marketReasonCodes.providerUnreachable;
}

/**
 * The primary pair is the deepest pool in which the asset is the base token.
 * A pair where the asset is only the quote is not a price of the asset.
 */
export function selectPrimaryPair(
  snapshot: TokenPairsSnapshot,
): TokenPairSnapshot | null {
  let best: TokenPairSnapshot | null = null;
  for (const pair of snapshot.pairs) {
    if (pair.baseTokenAddress !== snapshot.tokenAddress) {
      continue;
    }
    if (best === null) {
      best = pair;
      continue;
    }
    const left = pair.liquidityUsd ?? "0";
    const right = best.liquidityUsd ?? "0";
    if (compareDecimalStrings(left, right) > 0) {
      best = pair;
    }
  }
  return best;
}

export function createMarketFactService(
  input: CreateMarketFactServiceInput,
): MarketFactService {
  const now = input.now ?? ((): Date => new Date());

  async function read<T extends object>(request: {
    readonly subjectKey: string;
    readonly factKind: string;
    readonly source: MarketSource;
    readonly ttlSeconds: number;
    readonly disabledReasonCode: string;
    readonly fetch: (() => Promise<ProviderObservation<T>>) | null;
    readonly options: ReadFactOptions;
  }): Promise<CachedFact<T>> {
    if (request.fetch === null) {
      return unavailableFact(
        request.source,
        request.ttlSeconds,
        request.disabledReasonCode,
      );
    }
    let cached: MarketFactCacheRecord | null;
    try {
      cached = await input.cache.get(
        request.subjectKey,
        request.factKind,
        request.source,
      );
    } catch (error) {
      if (!(error instanceof MarketFactCacheUnavailableError)) {
        throw error;
      }
      return unavailableFact(
        request.source,
        request.ttlSeconds,
        marketReasonCodes.cacheUnavailable,
      );
    }
    const nowMs = now().getTime();
    const ageSeconds =
      cached === null
        ? Number.POSITIVE_INFINITY
        : (nowMs - Date.parse(cached.fetchedAt)) / 1_000;
    if (cached !== null && ageSeconds >= 0 && ageSeconds < cached.ttlSeconds) {
      return Object.freeze({
        value: cached.value as unknown as T,
        source: request.source,
        fetchedAt: cached.fetchedAt,
        ttlSeconds: cached.ttlSeconds,
        quality: "fresh",
        reasonCode: null,
        rawDigest: cached.rawDigest,
      });
    }

    let observation: ProviderObservation<T>;
    try {
      observation = await request.fetch();
    } catch (error) {
      if (!(error instanceof MarketProviderError)) {
        throw error;
      }
      const reasonCode = providerReasonCode(error);
      if (
        cached !== null &&
        request.options.requireFresh !== true &&
        ageSeconds < cached.ttlSeconds + input.config.staleGraceSeconds
      ) {
        return Object.freeze({
          value: cached.value as unknown as T,
          source: request.source,
          fetchedAt: cached.fetchedAt,
          ttlSeconds: cached.ttlSeconds,
          quality: "stale",
          reasonCode,
          rawDigest: cached.rawDigest,
        });
      }
      return unavailableFact(request.source, request.ttlSeconds, reasonCode);
    }
    try {
      await input.cache.put({
        subjectKey: request.subjectKey,
        factKind: request.factKind,
        source: request.source,
        value: observation.value as unknown as Record<string, unknown>,
        rawDigest: observation.rawDigest,
        fetchedAt: observation.fetchedAt,
        ttlSeconds: request.ttlSeconds,
      });
    } catch (error) {
      if (!(error instanceof MarketFactCacheUnavailableError)) {
        throw error;
      }
      // A cache write failure does not invalidate the fact just observed.
    }
    return Object.freeze({
      value: observation.value,
      source: request.source,
      fetchedAt: observation.fetchedAt,
      ttlSeconds: request.ttlSeconds,
      quality: "fresh",
      reasonCode: null,
      rawDigest: observation.rawDigest,
    });
  }

  const service: MarketFactService = {
    readTokenPairs(tokenAddress: string, options: ReadFactOptions = {}) {
      const provider = input.pairsProvider;
      return read<TokenPairsSnapshot>({
        subjectKey: `token:${tokenAddress}`,
        factKind: marketFactKinds.tokenPairs,
        source: "dexscreener",
        ttlSeconds: input.config.priceTtlSeconds,
        disabledReasonCode: marketReasonCodes.dexscreenerDisabled,
        fetch:
          provider === null
            ? null
            : () =>
                provider.readTokenPairs(
                  tokenAddress,
                  options.signal === undefined
                    ? {}
                    : { signal: options.signal },
                ),
        options,
      });
    },

    readTokenSecurity(tokenAddress: string, options: ReadFactOptions = {}) {
      const provider = input.securityProvider;
      return read<TokenSecuritySnapshot>({
        subjectKey: `token:${tokenAddress}`,
        factKind: marketFactKinds.tokenSecurity,
        source: "goplus",
        ttlSeconds: input.config.securityTtlSeconds,
        disabledReasonCode: marketReasonCodes.goplusNotConfigured,
        fetch:
          provider === null
            ? null
            : () =>
                provider.readTokenSecurity(
                  tokenAddress,
                  options.signal === undefined
                    ? {}
                    : { signal: options.signal },
                ),
        options,
      });
    },

    readPoolOhlcv(request, options: ReadFactOptions = {}) {
      const provider = input.candlesProvider;
      return read<PoolOhlcvSnapshot>({
        subjectKey: `pool:${request.poolAddress}:${request.timeframe}:${request.tokenAddress}:${String(request.limit)}`,
        factKind: marketFactKinds.poolOhlcv,
        source: "geckoterminal",
        ttlSeconds: input.config.candlesTtlSeconds,
        disabledReasonCode: marketReasonCodes.geckoterminalDisabled,
        fetch:
          provider === null
            ? null
            : () =>
                provider.readPoolOhlcv(
                  request.poolAddress,
                  request.timeframe,
                  request.limit,
                  {
                    tokenAddress: request.tokenAddress,
                    ...(options.signal === undefined
                      ? {}
                      : { signal: options.signal }),
                  },
                ),
        options,
      });
    },

    readNewPools(options: ReadFactOptions = {}) {
      const provider = input.candlesProvider;
      return read<NewPoolsSnapshot>({
        subjectKey: "chain:eip155:56",
        factKind: marketFactKinds.newPools,
        source: "geckoterminal",
        ttlSeconds: input.config.candlesTtlSeconds,
        disabledReasonCode: marketReasonCodes.geckoterminalDisabled,
        fetch:
          provider === null
            ? null
            : () =>
                provider.readNewPools(
                  options.signal === undefined
                    ? {}
                    : { signal: options.signal },
                ),
        options,
      });
    },

    candlesProviderEnabled: input.candlesProvider !== null,
  };
  return Object.freeze(service);
}
