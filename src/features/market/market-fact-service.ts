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
  type PairSnapshot,
  type OhlcvTimeframe,
  type PoolOhlcvSnapshot,
  type ProviderObservation,
  type SecurityFactsProvider,
  type TokenLookupProvider,
  type TokenLookupSnapshot,
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
 * Identity of a token the registry does not know, as one Provider reported
 * it (Decision 0058). Any field the Provider did not report is `null`;
 * nothing is filled in from another source.
 */
export interface UnlistedTokenIdentity {
  readonly symbol: string | null;
  readonly name: string | null;
  readonly decimals: number | null;
}

export interface UnlistedTokenPair {
  readonly pairAddress: string;
  readonly dexId: string;
  readonly labels: readonly string[];
  readonly quoteTokenAddress: string;
  readonly quoteTokenSymbol: string;
  readonly pairCreatedAt: string | null;
}

export interface UnlistedTokenMarket {
  readonly priceUsd: string | null;
  readonly priceChangeH24: string | null;
  readonly liquidityUsd: string | null;
  readonly volumeH24: string | null;
  readonly marketCap: string | null;
  readonly fdv: string | null;
  readonly primaryPair: UnlistedTokenPair | null;
}

export interface UnlistedTokenFact {
  readonly identity: CachedFact<UnlistedTokenIdentity>;
  readonly market: CachedFact<UnlistedTokenMarket>;
  /**
   * True only when every enabled lookup Provider affirmatively answered
   * that it knows no such token. A Provider that could not be reached
   * leaves this false: absence of an answer is not an answer.
   */
  readonly notFound: boolean;
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
   * One pair by its own pool address, for a Mining reference pricing rule
   * that declares it (Decision 0059).
   */
  readPair(
    pairAddress: string,
    options?: ReadFactOptions,
  ): Promise<CachedFact<PairSnapshot>>;
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
  /**
   * Describe a token the registry does not know (Decision 0058):
   * GeckoTerminal's token lookup first, the DexScreener pairs Provider as
   * the fallback, each with its own cache row and TTL. The identity is
   * kept for `unlistedMetadataTtlSeconds`, the market facts for
   * `unlistedPriceTtlSeconds`.
   */
  readUnlistedToken(
    tokenAddress: string,
    options?: ReadFactOptions,
  ): Promise<UnlistedTokenFact>;
  readonly candlesProviderEnabled: boolean;
}

export interface CreateMarketFactServiceInput {
  readonly config: MarketConfig;
  readonly cache: MarketFactCacheRepository;
  readonly pairsProvider: MarketPairsProvider | null;
  readonly securityProvider: SecurityFactsProvider | null;
  readonly candlesProvider: CandlesProvider | null;
  /** Unregistered-address lookup Provider (Decision 0058); `null` when GeckoTerminal is disabled. */
  readonly tokenLookupProvider?: TokenLookupProvider | null;
  readonly now?: () => Date;
}

export const marketFactKinds = Object.freeze({
  tokenPairs: "token_pairs",
  pair: "pair",
  tokenSecurity: "token_security",
  poolOhlcv: "pool_ohlcv",
  newPools: "new_pools",
  /** GeckoTerminal token lookup snapshot (price-class TTL). */
  tokenLookup: "token_lookup",
  /** Identity of an unregistered token as one Provider reported it (metadata TTL). */
  tokenIdentity: "token_identity",
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

  function readTokenPairsWithTtl(
    tokenAddress: string,
    ttlSeconds: number,
    options: ReadFactOptions,
  ): Promise<CachedFact<TokenPairsSnapshot>> {
    const provider = input.pairsProvider;
    const key = `token:${tokenAddress}|${marketFactKinds.tokenPairs}|${String(options.requireFresh === true)}|${String(ttlSeconds)}`;
    return dedupe(key, () =>
      read<TokenPairsSnapshot>({
        subjectKey: `token:${tokenAddress}`,
        factKind: marketFactKinds.tokenPairs,
        source: "dexscreener",
        ttlSeconds,
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
  }

  const service: MarketFactService = {
    readTokenPairs(tokenAddress: string, options: ReadFactOptions = {}) {
      return readTokenPairsWithTtl(
        tokenAddress,
        input.config.priceTtlSeconds,
        options,
      );
    },

    readPair(pairAddress: string, options: ReadFactOptions = {}) {
      const provider = input.pairsProvider;
      const key = `pair:${pairAddress}|${marketFactKinds.pair}|${String(options.requireFresh === true)}`;
      return dedupe(key, () =>
        read<PairSnapshot>({
          subjectKey: `pair:${pairAddress}`,
          factKind: marketFactKinds.pair,
          source: "dexscreener",
          ttlSeconds: input.config.priceTtlSeconds,
          disabledReasonCode: marketReasonCodes.dexscreenerDisabled,
          fetch:
            provider === null
              ? null
              : () =>
                  provider.readPair(
                    pairAddress,
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

    async readUnlistedToken(
      tokenAddress: string,
      options: ReadFactOptions = {},
    ): Promise<UnlistedTokenFact> {
      const lookup = input.tokenLookupProvider ?? null;
      const pairs = input.pairsProvider;
      const priceTtl = input.config.unlistedPriceTtlSeconds;
      const metadataTtl = input.config.unlistedMetadataTtlSeconds;
      const subjectKey = `token:${tokenAddress}`;
      const signalOption =
        options.signal === undefined ? {} : { signal: options.signal };

      async function rememberIdentity(
        source: MarketSource,
        identity: UnlistedTokenIdentity,
        rawDigest: string,
        fetchedAt: string,
      ): Promise<void> {
        try {
          await input.cache.put({
            subjectKey,
            factKind: marketFactKinds.tokenIdentity,
            source,
            value: identity as unknown as Record<string, unknown>,
            rawDigest,
            fetchedAt,
            ttlSeconds: metadataTtl,
          });
        } catch (error) {
          if (!(error instanceof MarketFactCacheUnavailableError)) {
            throw error;
          }
        }
      }

      // GeckoTerminal first: one request carries identity, token-level
      // market facts, and the top pools.
      let lookupFact: CachedFact<TokenLookupSnapshot> | null = null;
      if (lookup !== null) {
        lookupFact = await dedupe(
          `${subjectKey}|${marketFactKinds.tokenLookup}`,
          () =>
            read<TokenLookupSnapshot>({
              subjectKey,
              factKind: marketFactKinds.tokenLookup,
              source: lookup.source,
              ttlSeconds: priceTtl,
              disabledReasonCode: marketReasonCodes.geckoterminalDisabled,
              fetch: async () => {
                const observation = await lookup.readToken(
                  tokenAddress,
                  signalOption,
                );
                await rememberIdentity(
                  observation.source,
                  identityFromLookup(observation.value),
                  observation.rawDigest,
                  observation.fetchedAt,
                );
                return observation;
              },
              options,
            }),
        );
        if (lookupFact.value !== null && lookupFact.fetchedAt !== null) {
          const quality = lookupFact.quality === "stale" ? "stale" : "fresh";
          return Object.freeze({
            identity: Object.freeze({
              value: identityFromLookup(lookupFact.value),
              source: lookupFact.source,
              fetchedAt: lookupFact.fetchedAt,
              ttlSeconds: metadataTtl,
              quality,
              reasonCode: lookupFact.reasonCode,
              rawDigest: lookupFact.rawDigest,
            }),
            market: Object.freeze({
              value: marketFromLookup(lookupFact.value),
              source: lookupFact.source,
              fetchedAt: lookupFact.fetchedAt,
              ttlSeconds: priceTtl,
              quality,
              reasonCode: lookupFact.reasonCode,
              rawDigest: lookupFact.rawDigest,
            }),
            notFound: false,
          });
        }
      }
      const lookupNotFound =
        lookupFact !== null &&
        lookupFact.reasonCode === marketReasonCodes.tokenNotFound;

      // DexScreener fallback: the token's pairs, cached with the lookup's
      // price TTL rather than the registry price TTL.
      let pairsFact: CachedFact<TokenPairsSnapshot> | null = null;
      let pairsNotFound = false;
      if (pairs !== null) {
        pairsFact = await readTokenPairsWithTtl(
          tokenAddress,
          priceTtl,
          options,
        );
        if (pairsFact.value !== null && pairsFact.fetchedAt !== null) {
          const identity = identityFromPairs(pairsFact.value);
          if (identity === null) {
            // DexScreener answers an unknown token with an empty list.
            pairsNotFound = true;
          } else {
            if (pairsFact.quality === "fresh" && pairsFact.rawDigest !== null) {
              await rememberIdentity(
                pairsFact.source,
                identity,
                pairsFact.rawDigest,
                pairsFact.fetchedAt,
              );
            }
            const quality = pairsFact.quality === "stale" ? "stale" : "fresh";
            return Object.freeze({
              identity: Object.freeze({
                value: identity,
                source: pairsFact.source,
                fetchedAt: pairsFact.fetchedAt,
                ttlSeconds: metadataTtl,
                quality,
                reasonCode: pairsFact.reasonCode,
                rawDigest: pairsFact.rawDigest,
              }),
              market: Object.freeze({
                value: marketFromPairs(pairsFact.value),
                source: pairsFact.source,
                fetchedAt: pairsFact.fetchedAt,
                ttlSeconds: priceTtl,
                quality,
                reasonCode: pairsFact.reasonCode,
                rawDigest: pairsFact.rawDigest,
              }),
              notFound: false,
            });
          }
        }
      }

      const notFound =
        (lookup !== null || pairs !== null) &&
        (lookup === null || lookupNotFound) &&
        (pairs === null || pairsNotFound);
      const marketReason =
        lookup === null && pairs === null
          ? marketReasonCodes.lookupProviderDisabled
          : notFound
            ? marketReasonCodes.tokenNotFound
            : ((lookupFact !== null && !lookupNotFound
                ? lookupFact.reasonCode
                : null) ??
              (pairsFact !== null && !pairsNotFound
                ? pairsFact.reasonCode
                : null) ??
              lookupFact?.reasonCode ??
              pairsFact?.reasonCode ??
              marketReasonCodes.providerUnreachable);
      const marketSource: MarketSource =
        lookup !== null ? lookup.source : "dexscreener";
      const market = unavailableFact<UnlistedTokenMarket>(
        marketSource,
        priceTtl,
        marketReason,
      );

      // No live answer: the identity may still be known from a lookup
      // inside the metadata TTL. It is published as `stale` because the
      // Provider could not confirm it now.
      if (!notFound) {
        for (const source of [
          ...(lookup === null ? [] : [lookup.source]),
          ...(pairs === null ? [] : [pairs.source]),
        ]) {
          let cached: MarketFactCacheRecord | null = null;
          try {
            cached = await input.cache.get(
              subjectKey,
              marketFactKinds.tokenIdentity,
              source,
            );
          } catch (error) {
            if (!(error instanceof MarketFactCacheUnavailableError)) {
              throw error;
            }
          }
          if (cached === null) {
            continue;
          }
          const ageSeconds =
            (now().getTime() - Date.parse(cached.fetchedAt)) / 1_000;
          if (ageSeconds < 0 || ageSeconds >= cached.ttlSeconds) {
            continue;
          }
          return Object.freeze({
            identity: Object.freeze({
              value: cached.value as unknown as UnlistedTokenIdentity,
              source,
              fetchedAt: cached.fetchedAt,
              ttlSeconds: cached.ttlSeconds,
              quality: "stale" as const,
              reasonCode: marketReason,
              rawDigest: cached.rawDigest,
            }),
            market,
            notFound: false,
          });
        }
      }
      return Object.freeze({
        identity: unavailableFact<UnlistedTokenIdentity>(
          marketSource,
          metadataTtl,
          marketReason,
        ),
        market,
        notFound,
      });
    },

    candlesProviderEnabled: input.candlesProvider !== null,
  };
  return Object.freeze(service);
}

function identityFromLookup(
  snapshot: TokenLookupSnapshot,
): UnlistedTokenIdentity {
  return Object.freeze({
    symbol: snapshot.symbol,
    name: snapshot.name,
    decimals: snapshot.decimals,
  });
}

/**
 * GeckoTerminal market facts: price, FDV, market cap, and 24h volume are
 * token-level attributes; liquidity and 24h change are read from the top
 * pool, which the response names as `primaryPair` so the client can
 * attribute them.
 */
function marketFromLookup(snapshot: TokenLookupSnapshot): UnlistedTokenMarket {
  const pool = snapshot.topPools[0] ?? null;
  return Object.freeze({
    priceUsd: snapshot.priceUsd,
    priceChangeH24: pool?.priceChangeH24 ?? null,
    liquidityUsd: pool?.reserveUsd ?? null,
    volumeH24: snapshot.volumeH24Usd,
    marketCap: snapshot.marketCapUsd,
    fdv: snapshot.fdvUsd,
    primaryPair:
      pool === null || pool.quoteTokenAddress === null
        ? null
        : Object.freeze({
            pairAddress: pool.poolAddress,
            dexId: pool.dexId,
            labels: Object.freeze([]),
            quoteTokenAddress: pool.quoteTokenAddress,
            quoteTokenSymbol: pool.quoteTokenSymbol ?? "",
            pairCreatedAt: pool.createdAt,
          }),
  });
}

/**
 * DexScreener identity: the base token of the deepest base pair, else the
 * quote side of any pair the token appears in (symbol only). Decimals are
 * never reported by DexScreener and stay `null`.
 */
function identityFromPairs(
  snapshot: TokenPairsSnapshot,
): UnlistedTokenIdentity | null {
  const primary = selectPrimaryPair(snapshot);
  if (primary !== null) {
    return Object.freeze({
      symbol:
        primary.baseTokenSymbol.length === 0 ? null : primary.baseTokenSymbol,
      name: primary.baseTokenName ?? null,
      decimals: null,
    });
  }
  const asQuote = snapshot.pairs.find(
    (pair) => pair.quoteTokenAddress === snapshot.tokenAddress,
  );
  if (asQuote === undefined) {
    return null;
  }
  return Object.freeze({
    symbol:
      asQuote.quoteTokenSymbol.length === 0 ? null : asQuote.quoteTokenSymbol,
    name: null,
    decimals: null,
  });
}

function marketFromPairs(snapshot: TokenPairsSnapshot): UnlistedTokenMarket {
  const pair = selectPrimaryPair(snapshot);
  if (pair === null) {
    return Object.freeze({
      priceUsd: null,
      priceChangeH24: null,
      liquidityUsd: null,
      volumeH24: null,
      marketCap: null,
      fdv: null,
      primaryPair: null,
    });
  }
  return Object.freeze({
    priceUsd: pair.priceUsd,
    priceChangeH24: pair.priceChangeH24,
    liquidityUsd: pair.liquidityUsd,
    volumeH24: pair.volumeH24,
    marketCap: pair.marketCap,
    fdv: pair.fdv,
    primaryPair: Object.freeze({
      pairAddress: pair.pairAddress,
      dexId: pair.dexId,
      labels: pair.labels,
      quoteTokenAddress: pair.quoteTokenAddress,
      quoteTokenSymbol: pair.quoteTokenSymbol,
      pairCreatedAt: pair.pairCreatedAt,
    }),
  });
}
