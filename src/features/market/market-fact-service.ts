import type { MarketConfig } from "../../config.js";
import {
  MarketFactCacheUnavailableError,
  type MarketFactCacheRecord,
  type MarketFactCacheRepository,
} from "../../database/market-fact-cache-repository.js";
import {
  marketPairsBatchLimit,
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
import type { AssetRecord } from "../../database/chain-registry-repository.js";
import {
  bscWrappedNativeAddress,
  bscWrappedNativeAssetId,
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

/**
 * The price of one registry asset: the deepest base pair of the asset, or
 * for the native asset the wrapped native token's pair with `proxyAsset`
 * named. `pair` is null when no usable pair exists.
 */
export interface AssetPriceFact {
  readonly fact: CachedFact<TokenPairsSnapshot>;
  readonly pair: TokenPairSnapshot | null;
  readonly proxyAsset: string | null;
}

export interface MarketFactService {
  readTokenPairs(
    tokenAddress: string,
    options?: ReadFactOptions,
  ): Promise<CachedFact<TokenPairsSnapshot>>;
  /**
   * Pair snapshots for many tokens through the Provider's batch endpoint.
   * Cache hits are served without a request; misses are fetched in chunks.
   */
  readTokenPairsBatch(
    tokenAddresses: readonly string[],
    options?: ReadFactOptions,
  ): Promise<ReadonlyMap<string, CachedFact<TokenPairsSnapshot>>>;
  readAssetPrice(
    asset: Pick<AssetRecord, "address" | "status">,
    options?: ReadFactOptions,
  ): Promise<AssetPriceFact>;
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
  /** In-flight Provider reads keyed by subject so concurrent readers share one request. */
  const inFlight = new Map<string, Promise<CachedFact<object>>>();

  function dedupe<T extends object>(
    key: string,
    readFact: () => Promise<CachedFact<T>>,
  ): Promise<CachedFact<T>> {
    const pending = inFlight.get(key);
    if (pending !== undefined) {
      return pending as Promise<CachedFact<T>>;
    }
    const tracked = readFact().finally(() => {
      if (inFlight.get(key) === tracked) {
        inFlight.delete(key);
      }
    });
    inFlight.set(key, tracked);
    return tracked;
  }

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

  function pairsFact(
    cached: MarketFactCacheRecord,
    quality: "fresh" | "stale",
    reasonCode: string | null,
  ): CachedFact<TokenPairsSnapshot> {
    return Object.freeze({
      value: cached.value as unknown as TokenPairsSnapshot,
      source: "dexscreener" as const,
      fetchedAt: cached.fetchedAt,
      ttlSeconds: cached.ttlSeconds,
      quality,
      reasonCode,
      rawDigest: cached.rawDigest,
    });
  }

  const service: MarketFactService = {
    readTokenPairs(tokenAddress: string, options: ReadFactOptions = {}) {
      const provider = input.pairsProvider;
      const key = `token:${tokenAddress}|${marketFactKinds.tokenPairs}|${String(options.requireFresh === true)}`;
      return dedupe(key, () =>
        read<TokenPairsSnapshot>({
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
        }),
      );
    },

    async readTokenPairsBatch(
      tokenAddresses: readonly string[],
      options: ReadFactOptions = {},
    ) {
      const provider = input.pairsProvider;
      const results = new Map<string, CachedFact<TokenPairsSnapshot>>();
      const unique = [...new Set(tokenAddresses)];
      if (provider === null) {
        for (const address of unique) {
          results.set(
            address,
            unavailableFact(
              "dexscreener",
              input.config.priceTtlSeconds,
              marketReasonCodes.dexscreenerDisabled,
            ),
          );
        }
        return results;
      }
      const nowMs = now().getTime();
      const misses: {
        readonly address: string;
        readonly cached: MarketFactCacheRecord | null;
        readonly ageSeconds: number;
      }[] = [];
      for (const address of unique) {
        let cached: MarketFactCacheRecord | null;
        try {
          cached = await input.cache.get(
            `token:${address}`,
            marketFactKinds.tokenPairs,
            "dexscreener",
          );
        } catch (error) {
          if (!(error instanceof MarketFactCacheUnavailableError)) {
            throw error;
          }
          results.set(
            address,
            unavailableFact(
              "dexscreener",
              input.config.priceTtlSeconds,
              marketReasonCodes.cacheUnavailable,
            ),
          );
          continue;
        }
        const ageSeconds =
          cached === null
            ? Number.POSITIVE_INFINITY
            : (nowMs - Date.parse(cached.fetchedAt)) / 1_000;
        if (
          cached !== null &&
          ageSeconds >= 0 &&
          ageSeconds < cached.ttlSeconds
        ) {
          results.set(address, pairsFact(cached, "fresh", null));
          continue;
        }
        misses.push({ address, cached, ageSeconds });
      }
      for (
        let offset = 0;
        offset < misses.length;
        offset += marketPairsBatchLimit
      ) {
        const chunk = misses.slice(offset, offset + marketPairsBatchLimit);
        let observation: ProviderObservation<
          readonly TokenPairsSnapshot[]
        > | null = null;
        let reasonCode: string = marketReasonCodes.providerUnreachable;
        try {
          observation = await provider.readTokenPairsBatch(
            chunk.map((miss) => miss.address),
            options.signal === undefined ? {} : { signal: options.signal },
          );
        } catch (error) {
          if (!(error instanceof MarketProviderError)) {
            throw error;
          }
          reasonCode = error.reasonCode;
        }
        for (const miss of chunk) {
          const snapshot = observation?.value.find(
            (entry) => entry.tokenAddress === miss.address,
          );
          if (observation !== null && snapshot !== undefined) {
            try {
              await input.cache.put({
                subjectKey: `token:${miss.address}`,
                factKind: marketFactKinds.tokenPairs,
                source: "dexscreener",
                value: snapshot as unknown as Record<string, unknown>,
                rawDigest: observation.rawDigest,
                fetchedAt: observation.fetchedAt,
                ttlSeconds: input.config.priceTtlSeconds,
              });
            } catch (error) {
              if (!(error instanceof MarketFactCacheUnavailableError)) {
                throw error;
              }
            }
            results.set(
              miss.address,
              Object.freeze({
                value: snapshot,
                source: "dexscreener" as const,
                fetchedAt: observation.fetchedAt,
                ttlSeconds: input.config.priceTtlSeconds,
                quality: "fresh" as const,
                reasonCode: null,
                rawDigest: observation.rawDigest,
              }),
            );
            continue;
          }
          if (
            miss.cached !== null &&
            options.requireFresh !== true &&
            miss.ageSeconds <
              miss.cached.ttlSeconds + input.config.staleGraceSeconds
          ) {
            results.set(
              miss.address,
              pairsFact(miss.cached, "stale", reasonCode),
            );
            continue;
          }
          results.set(
            miss.address,
            unavailableFact(
              "dexscreener",
              input.config.priceTtlSeconds,
              reasonCode,
            ),
          );
        }
      }
      return results;
    },

    async readAssetPrice(
      asset: Pick<AssetRecord, "address" | "status">,
      options: ReadFactOptions = {},
    ) {
      if (asset.status === "blocked") {
        return Object.freeze({
          fact: unavailableFact<TokenPairsSnapshot>(
            "dexscreener",
            input.config.priceTtlSeconds,
            "ASSET_BLOCKED",
          ),
          pair: null,
          proxyAsset: null,
        });
      }
      const proxied = asset.address === null;
      const fact = await service.readTokenPairs(
        asset.address ?? bscWrappedNativeAddress,
        options,
      );
      return Object.freeze({
        fact,
        pair: fact.value === null ? null : selectPrimaryPair(fact.value),
        proxyAsset: proxied ? bscWrappedNativeAssetId : null,
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
