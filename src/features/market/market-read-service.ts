import { randomUUID } from "node:crypto";

import type { AuthenticatedLoopPrincipal } from "../../core/http/authentication.js";
import {
  InvalidV2CursorError,
  type V2CursorCodec,
} from "../../core/http/v2-cursor.js";
import { V2ApiError } from "../../core/http/v2-error.js";
import type {
  BscIndexerRepository,
  IndexedPoolEventRecord,
} from "../../database/bsc-indexer-repository.js";
import type {
  AssetRecord,
  ChainRegistryRepository,
  PoolRecord,
} from "../../database/chain-registry-repository.js";
import {
  MarketFactCacheUnavailableError,
  type MarketFactCacheRepository,
} from "../../database/market-fact-cache-repository.js";
import type { WatchlistV2Repository } from "../../database/watchlist-v2-repository.js";
import type { BscReadClient } from "../../integrations/bsc/rpc-client.js";
import type { TokenPairSnapshot } from "../../integrations/market/market-data-provider.js";
import {
  decomposeAssetId,
  formatDecimalAmount,
  isAssetId,
} from "../chain/chain-contract.js";
import {
  projectAssetCapability,
  type AssetCapabilityProjection,
  type AssetProjection,
} from "../chain/asset-registry-service.js";
import { v2ContractVersion } from "../meta/product-policy.js";
import {
  availableFact,
  candleIntervalSeconds,
  candleLimits,
  compareDecimalStrings,
  derivedCandleLabelKey,
  isCandleInterval,
  marketReasonCodes,
  marketTrendingRules,
  sqrtPriceX96ToAssetPrice,
  tradeLimits,
  unavailableFact,
  type CandleInterval,
  type MarketFactProjection,
  type MarketSource,
} from "./market-contract.js";
import {
  selectPrimaryPair,
  type CachedFact,
  type MarketFactService,
} from "./market-fact-service.js";

/**
 * V2 market read surface (Decision 0034).
 *
 * Every block of every response is independently `available` or
 * `unavailable` with a reason; a Provider that is off, throttled, or silent
 * closes only its own block. Nothing here infers one fact from another
 * source, converts a missing number to zero, or rounds a decimal string.
 */

export interface AssetSummaryProjection {
  readonly symbol: string;
  readonly name: string;
  readonly decimals: number;
  readonly status: AssetRecord["status"];
}

export interface UnavailableBlock {
  readonly status: "unavailable";
  readonly reasonCode: string;
}

export interface MarketAssetRow {
  readonly assetId: string;
  readonly asset: AssetSummaryProjection | null;
  readonly price: MarketFactProjection;
  readonly priceChange24h: MarketFactProjection;
}

export interface TrendingRow extends MarketAssetRow {
  readonly volume24h: MarketFactProjection;
  readonly liquidityUsd: MarketFactProjection;
}

export interface MarketOverviewResource {
  readonly watchlist:
    | {
        readonly status: "available";
        readonly version: number;
        readonly items: readonly MarketAssetRow[];
      }
    | UnavailableBlock;
  readonly trending:
    | {
        readonly status: "available";
        readonly recommendationId: string;
        readonly rules: {
          readonly configVersion: string;
          readonly effectiveAt: string;
          readonly ordering: string;
        };
        readonly items: readonly TrendingRow[];
      }
    | UnavailableBlock;
  readonly newPairs: { readonly status: "available" } | UnavailableBlock;
  readonly smartMoney: UnavailableBlock;
  readonly observedAt: string;
  readonly contractVersion: typeof v2ContractVersion;
}

export interface PrimaryPairProjection {
  readonly pairAddress: string;
  readonly dexId: string;
  readonly labels: readonly string[];
  readonly quoteTokenAddress: string;
  readonly quoteTokenSymbol: string;
  readonly pairCreatedAt: string | null;
}

export interface SecurityFactRow {
  readonly fact: string;
  readonly value: string;
  readonly source: MarketSource;
  readonly observedAt: string;
}

export interface MarketAssetResource {
  readonly asset: AssetProjection;
  readonly capability: AssetCapabilityProjection;
  readonly price: MarketFactProjection;
  readonly priceChange24h: MarketFactProjection;
  readonly liquidityUsd: MarketFactProjection;
  readonly volume24h: MarketFactProjection;
  readonly marketCap: MarketFactProjection;
  readonly fdv: MarketFactProjection;
  readonly primaryPair: PrimaryPairProjection | null;
  readonly community:
    | {
        readonly status: "available";
        readonly communityId: string;
        readonly name: string;
        readonly slug: string;
        readonly memberCount: number;
      }
    | UnavailableBlock;
  readonly security:
    | {
        readonly status: "available";
        readonly source: MarketSource;
        readonly fetchedAt: string;
        readonly ttlSeconds: number;
        readonly quality: "fresh" | "stale";
        readonly reasonCode: string | null;
        readonly facts: readonly SecurityFactRow[];
      }
    | UnavailableBlock;
  readonly holderCount: MarketFactProjection;
  readonly contractVersion: typeof v2ContractVersion;
}

export interface CandleProjection {
  readonly openTime: string;
  readonly closeTime: string;
  readonly open: string;
  readonly high: string;
  readonly low: string;
  readonly close: string;
  readonly volume: string;
  readonly swapCount: number | null;
}

export interface MarketCandlesResource {
  readonly assetId: string;
  readonly interval: CandleInterval;
  readonly candles:
    | {
        readonly status: "available";
        readonly quality: "fresh" | "stale" | "derived";
        readonly source: MarketSource;
        readonly fetchedAt: string;
        readonly labelKey: string | null;
        readonly pool: {
          readonly address: string;
          readonly protocol: string;
          readonly quoteAssetId: string | null;
          readonly quoteSymbol: string;
        };
        readonly priceUnit: string;
        readonly items: readonly CandleProjection[];
      }
    | UnavailableBlock;
  readonly contractVersion: typeof v2ContractVersion;
}

export interface TradeProjection {
  readonly transactionHash: string;
  readonly logIndex: number;
  readonly blockNumber: string;
  readonly blockHash: string;
  readonly blockTimestamp: string;
  readonly confirmations: number | null;
  readonly status: "confirmed" | "pending" | "reorged";
  readonly direction: "buy" | "sell";
  readonly amountAsset: string;
  readonly amountQuote: string;
  readonly quoteAssetId: string;
  readonly quoteSymbol: string;
  readonly priceAfter: string | null;
  readonly poolAddress: string;
  readonly sender: string | null;
  readonly recipient: string | null;
}

export interface MarketTradesResource {
  readonly assetId: string;
  readonly trades:
    | {
        readonly status: "available";
        readonly source: "loop_indexer";
        readonly items: readonly TradeProjection[];
        readonly nextCursor: string | null;
        readonly freshness: {
          readonly indexerBlockNumber: string;
          readonly headBlockNumber: string | null;
          readonly lagBlocks: number | null;
          readonly observedAt: string;
        };
      }
    | UnavailableBlock;
  readonly contractVersion: typeof v2ContractVersion;
}

export interface MarketHoldersResource {
  readonly assetId: string;
  readonly holderCount: MarketFactProjection;
  readonly distribution: UnavailableBlock;
  readonly contractVersion: typeof v2ContractVersion;
}

export interface NewPairRow {
  readonly poolAddress: string;
  readonly dexId: string;
  readonly name: string;
  readonly baseTokenAddress: string | null;
  readonly quoteTokenAddress: string | null;
  readonly registryAssetId: string | null;
  readonly createdAt: string | null;
  readonly reserveUsd: string | null;
  readonly volumeH24Usd: string | null;
}

export interface MarketNewPairsResource {
  readonly newPairs:
    | {
        readonly status: "available";
        readonly source: MarketSource;
        readonly fetchedAt: string;
        readonly ttlSeconds: number;
        readonly quality: "fresh" | "stale";
        readonly reasonCode: string | null;
        readonly items: readonly NewPairRow[];
      }
    | UnavailableBlock;
  readonly riskScreening: UnavailableBlock;
  readonly contractVersion: typeof v2ContractVersion;
}

export interface MarketSmartMoneyResource {
  readonly smartMoney: UnavailableBlock;
  readonly contractVersion: typeof v2ContractVersion;
}

export interface MarketReadService {
  getOverview(input: {
    readonly principal: AuthenticatedLoopPrincipal;
    readonly signal?: AbortSignal;
  }): Promise<MarketOverviewResource>;
  getAsset(input: {
    readonly assetId: unknown;
    readonly signal?: AbortSignal;
  }): Promise<MarketAssetResource>;
  getCandles(input: {
    readonly assetId: unknown;
    readonly interval: unknown;
    readonly limit?: unknown;
    readonly signal?: AbortSignal;
  }): Promise<MarketCandlesResource>;
  getTrades(input: {
    readonly principal: AuthenticatedLoopPrincipal;
    readonly assetId: unknown;
    readonly cursor?: unknown;
    readonly limit?: unknown;
  }): Promise<MarketTradesResource>;
  getHolders(input: {
    readonly assetId: unknown;
    readonly signal?: AbortSignal;
  }): Promise<MarketHoldersResource>;
  getNewPairs(input: {
    readonly signal?: AbortSignal;
  }): Promise<MarketNewPairsResource>;
  getSmartMoney(): MarketSmartMoneyResource;
}

export interface CreateMarketReadServiceInput {
  readonly registry: ChainRegistryRepository;
  readonly facts: MarketFactService;
  readonly cache: MarketFactCacheRepository;
  readonly indexerRepository: BscIndexerRepository;
  readonly watchlist: WatchlistV2Repository | null;
  readonly readClient: BscReadClient;
  readonly cursorCodec: V2CursorCodec | null;
  readonly chainId: string;
  readonly now?: () => Date;
  readonly createRecommendationId?: () => string;
}

const tradesCursorRoute = "marketTrades";
/** Registry assets scanned for the trending block; bounded to stay inside Provider limits. */
const trendingScanLimit = 50;

function unavailableBlock(reasonCode: string): UnavailableBlock {
  return Object.freeze({ status: "unavailable", reasonCode });
}

function summarize(asset: AssetRecord): AssetSummaryProjection {
  return Object.freeze({
    symbol: asset.symbol,
    name: asset.name,
    decimals: asset.decimals,
    status: asset.status,
  });
}

function projectAsset(record: AssetRecord): AssetProjection {
  return Object.freeze({
    assetId: record.assetId,
    chainId: record.chainId,
    address: record.address,
    symbol: record.symbol,
    name: record.name,
    decimals: record.decimals,
    status: record.status,
    source: Object.freeze({
      kind: record.sourceKind,
      blockNumber: record.sourceBlockNumber,
      verifiedAt: record.sourceVerifiedAt,
    }),
    updatedAt: record.updatedAt,
  });
}

interface PairFacts {
  readonly price: MarketFactProjection;
  readonly priceChange24h: MarketFactProjection;
  readonly liquidityUsd: MarketFactProjection;
  readonly volume24h: MarketFactProjection;
  readonly marketCap: MarketFactProjection;
  readonly fdv: MarketFactProjection;
  readonly primaryPair: PrimaryPairProjection | null;
  /** Raw volume string for ordering; null when unavailable. */
  readonly volumeForOrdering: string | null;
}

function pairFactsFromSnapshot(
  fact: CachedFact<{
    readonly tokenAddress: string;
    readonly pairs: readonly TokenPairSnapshot[];
  }>,
): PairFacts {
  const allUnavailable = (reasonCode: string): PairFacts =>
    Object.freeze({
      price: unavailableFact(reasonCode),
      priceChange24h: unavailableFact(reasonCode),
      liquidityUsd: unavailableFact(reasonCode),
      volume24h: unavailableFact(reasonCode),
      marketCap: unavailableFact(reasonCode),
      fdv: unavailableFact(reasonCode),
      primaryPair: null,
      volumeForOrdering: null,
    });
  if (fact.value === null || fact.fetchedAt === null) {
    return allUnavailable(
      fact.reasonCode ?? marketReasonCodes.providerUnreachable,
    );
  }
  const pair = selectPrimaryPair(fact.value);
  if (pair === null) {
    return allUnavailable(marketReasonCodes.pairNotFound);
  }
  const quality = fact.quality === "stale" ? "stale" : "fresh";
  const project = (value: string | null): MarketFactProjection =>
    value === null
      ? unavailableFact(marketReasonCodes.factMissing)
      : availableFact({
          value,
          source: fact.source,
          fetchedAt: fact.fetchedAt ?? "",
          ttlSeconds: fact.ttlSeconds,
          quality,
          reasonCode: fact.reasonCode,
        });
  return Object.freeze({
    price: project(pair.priceUsd),
    priceChange24h: project(pair.priceChangeH24),
    liquidityUsd: project(pair.liquidityUsd),
    volume24h: project(pair.volumeH24),
    marketCap: project(pair.marketCap),
    fdv: project(pair.fdv),
    primaryPair: Object.freeze({
      pairAddress: pair.pairAddress,
      dexId: pair.dexId,
      labels: pair.labels,
      quoteTokenAddress: pair.quoteTokenAddress,
      quoteTokenSymbol: pair.quoteTokenSymbol,
      pairCreatedAt: pair.pairCreatedAt,
    }),
    volumeForOrdering: pair.volumeH24,
  });
}

export function createMarketReadService(
  input: CreateMarketReadServiceInput,
): MarketReadService {
  const now = input.now ?? ((): Date => new Date());
  const createRecommendationId = input.createRecommendationId ?? randomUUID;

  async function requireAsset(assetId: unknown): Promise<AssetRecord> {
    if (!isAssetId(assetId)) {
      throw V2ApiError.invalidRequest();
    }
    if (decomposeAssetId(assetId).chainId !== input.chainId) {
      throw V2ApiError.fromCode("CHAIN_MISMATCH");
    }
    const record = await input.registry.getAsset(assetId);
    if (record === null) {
      throw V2ApiError.notFound();
    }
    return record;
  }

  async function pairFactsFor(
    asset: AssetRecord,
    signal: AbortSignal | undefined,
  ): Promise<PairFacts> {
    if (asset.status === "blocked") {
      return pairFactsFromSnapshot({
        value: null,
        source: "dexscreener",
        fetchedAt: null,
        ttlSeconds: 0,
        quality: "unavailable",
        reasonCode: "ASSET_BLOCKED",
        rawDigest: null,
      });
    }
    if (asset.address === null) {
      return pairFactsFromSnapshot({
        value: null,
        source: "dexscreener",
        fetchedAt: null,
        ttlSeconds: 0,
        quality: "unavailable",
        reasonCode: marketReasonCodes.nativeAssetUnsupported,
        rawDigest: null,
      });
    }
    const fact = await input.facts.readTokenPairs(
      asset.address,
      signal === undefined ? {} : { signal },
    );
    return pairFactsFromSnapshot(fact);
  }

  async function chainHead(): Promise<{
    readonly blockNumber: bigint;
    readonly observedAt: string;
  } | null> {
    try {
      const head = await input.readClient.getHead();
      return { blockNumber: head.blockNumber, observedAt: head.observedAt };
    } catch {
      return null;
    }
  }

  function poolsForAsset(
    pools: readonly PoolRecord[],
    assetId: string,
  ): readonly PoolRecord[] {
    return pools.filter(
      (pool) =>
        pool.token0AssetId === assetId || pool.token1AssetId === assetId,
    );
  }

  const service: MarketReadService = {
    async getOverview({ principal, signal }) {
      const observedAt = now().toISOString();
      const readable = await input.registry.listReadableAssets(input.chainId);
      const byId = new Map(readable.map((asset) => [asset.assetId, asset]));

      let watchlist: MarketOverviewResource["watchlist"];
      if (input.watchlist === null) {
        watchlist = unavailableBlock(marketReasonCodes.watchlistUnavailable);
      } else {
        const snapshot = await input.watchlist.get(principal.userId);
        const seen = new Set<string>();
        const rows: MarketAssetRow[] = [];
        for (const group of snapshot.groups) {
          for (const item of group.items) {
            if (seen.has(item.assetId)) {
              continue;
            }
            seen.add(item.assetId);
            const asset = byId.get(item.assetId);
            if (asset === undefined) {
              rows.push(
                Object.freeze({
                  assetId: item.assetId,
                  asset: null,
                  price: unavailableFact("ASSET_NOT_READABLE"),
                  priceChange24h: unavailableFact("ASSET_NOT_READABLE"),
                }),
              );
              continue;
            }
            const facts = await pairFactsFor(asset, signal);
            rows.push(
              Object.freeze({
                assetId: asset.assetId,
                asset: summarize(asset),
                price: facts.price,
                priceChange24h: facts.priceChange24h,
              }),
            );
          }
        }
        watchlist = Object.freeze({
          status: "available",
          version: snapshot.version,
          items: Object.freeze(rows),
        });
      }

      const candidates: TrendingRow[] = [];
      for (const asset of readable.slice(0, trendingScanLimit)) {
        if (asset.address === null) {
          continue;
        }
        const facts = await pairFactsFor(asset, signal);
        if (facts.volumeForOrdering === null) {
          continue;
        }
        candidates.push(
          Object.freeze({
            assetId: asset.assetId,
            asset: summarize(asset),
            price: facts.price,
            priceChange24h: facts.priceChange24h,
            volume24h: facts.volume24h,
            liquidityUsd: facts.liquidityUsd,
          }),
        );
      }
      candidates.sort((left, right) =>
        compareDecimalStrings(
          right.volume24h.value ?? "0",
          left.volume24h.value ?? "0",
        ),
      );
      const trending: MarketOverviewResource["trending"] = readable.every(
        (asset) => asset.address === null,
      )
        ? unavailableBlock("ASSET_REGISTRY_EMPTY")
        : candidates.length === 0
          ? unavailableBlock(marketReasonCodes.dexscreenerDisabled)
          : Object.freeze({
              status: "available",
              recommendationId: createRecommendationId(),
              rules: Object.freeze({
                configVersion: marketTrendingRules.configVersion,
                effectiveAt: marketTrendingRules.effectiveAt,
                ordering: marketTrendingRules.ordering,
              }),
              items: Object.freeze(
                candidates.slice(0, marketTrendingRules.maximumItems),
              ),
            });

      return Object.freeze({
        watchlist,
        trending,
        newPairs: input.facts.candlesProviderEnabled
          ? Object.freeze({ status: "available" as const })
          : unavailableBlock(marketReasonCodes.geckoterminalDisabled),
        smartMoney: unavailableBlock(marketReasonCodes.smartMoneyDeferred),
        observedAt,
        contractVersion: v2ContractVersion,
      });
    },

    async getAsset({ assetId, signal }) {
      const asset = await requireAsset(assetId);
      const chainReadable =
        (await input.readClient.verifyChain()) === "verified";
      const facts = await pairFactsFor(asset, signal);

      let community: MarketAssetResource["community"];
      try {
        const bound = await input.cache.findVerifiedCommunityByAssetId(
          asset.assetId,
        );
        community =
          bound === null
            ? unavailableBlock(marketReasonCodes.communityNotBound)
            : Object.freeze({
                status: "available",
                communityId: bound.communityId,
                name: bound.name,
                slug: bound.slug,
                memberCount: bound.memberCount,
              });
      } catch (error) {
        if (!(error instanceof MarketFactCacheUnavailableError)) {
          throw error;
        }
        community = unavailableBlock(marketReasonCodes.cacheUnavailable);
      }

      let security: MarketAssetResource["security"];
      let holderCount: MarketFactProjection;
      if (asset.address === null || asset.status === "blocked") {
        const reasonCode =
          asset.status === "blocked"
            ? "ASSET_BLOCKED"
            : marketReasonCodes.nativeAssetUnsupported;
        security = unavailableBlock(reasonCode);
        holderCount = unavailableFact(reasonCode);
      } else {
        const fact = await input.facts.readTokenSecurity(
          asset.address,
          signal === undefined ? {} : { signal },
        );
        if (fact.value === null || fact.fetchedAt === null) {
          const reasonCode =
            fact.reasonCode ?? marketReasonCodes.providerUnreachable;
          security = unavailableBlock(reasonCode);
          holderCount = unavailableFact(reasonCode);
        } else {
          const fetchedAt = fact.fetchedAt;
          const quality = fact.quality === "stale" ? "stale" : "fresh";
          security = Object.freeze({
            status: "available",
            source: fact.source,
            fetchedAt,
            ttlSeconds: fact.ttlSeconds,
            quality,
            reasonCode: fact.reasonCode,
            facts: Object.freeze(
              fact.value.facts.map((row) =>
                Object.freeze({
                  fact: row.fact,
                  value: row.value,
                  source: fact.source,
                  observedAt: fetchedAt,
                }),
              ),
            ),
          });
          holderCount =
            fact.value.holderCount === null
              ? unavailableFact(marketReasonCodes.factMissing)
              : availableFact({
                  value: fact.value.holderCount,
                  source: fact.source,
                  fetchedAt,
                  ttlSeconds: fact.ttlSeconds,
                  quality,
                  reasonCode: fact.reasonCode,
                });
        }
      }

      return Object.freeze({
        asset: projectAsset(asset),
        capability: projectAssetCapability(asset, chainReadable),
        price: facts.price,
        priceChange24h: facts.priceChange24h,
        liquidityUsd: facts.liquidityUsd,
        volume24h: facts.volume24h,
        marketCap: facts.marketCap,
        fdv: facts.fdv,
        primaryPair: facts.primaryPair,
        community,
        security,
        holderCount,
        contractVersion: v2ContractVersion,
      });
    },

    async getCandles({ assetId, interval, limit, signal }) {
      const asset = await requireAsset(assetId);
      if (!isCandleInterval(interval)) {
        throw V2ApiError.invalidRequest();
      }
      let pageSize: number = candleLimits.default;
      if (limit !== undefined) {
        if (
          typeof limit !== "number" ||
          !Number.isInteger(limit) ||
          limit < 1 ||
          limit > candleLimits.maximum
        ) {
          throw V2ApiError.invalidRequest();
        }
        pageSize = limit;
      }
      const unavailable = (reasonCode: string): MarketCandlesResource =>
        Object.freeze({
          assetId: asset.assetId,
          interval,
          candles: unavailableBlock(reasonCode),
          contractVersion: v2ContractVersion,
        });
      if (asset.status === "blocked") {
        return unavailable("ASSET_BLOCKED");
      }
      if (asset.address === null) {
        return unavailable(marketReasonCodes.nativeAssetUnsupported);
      }
      const pools = poolsForAsset(
        await input.registry.listPools(input.chainId),
        asset.assetId,
      );
      if (pools.length === 0) {
        return unavailable(marketReasonCodes.poolNotRegistered);
      }
      const intervalSeconds = candleIntervalSeconds[interval];

      // Provider path first: GeckoTerminal OHLCV in USD for the asset.
      if (input.facts.candlesProviderEnabled) {
        const pool = pools[0];
        if (pool !== undefined) {
          const fact = await input.facts.readPoolOhlcv(
            {
              poolAddress: pool.address,
              timeframe: interval,
              limit: pageSize,
              tokenAddress: asset.address,
            },
            signal === undefined ? {} : { signal },
          );
          if (fact.value !== null && fact.fetchedAt !== null) {
            return Object.freeze({
              assetId: asset.assetId,
              interval,
              candles: Object.freeze({
                status: "available" as const,
                quality:
                  fact.quality === "stale"
                    ? ("stale" as const)
                    : ("fresh" as const),
                source: fact.source,
                fetchedAt: fact.fetchedAt,
                labelKey: null,
                pool: Object.freeze({
                  address: pool.address,
                  protocol: pool.protocol,
                  quoteAssetId: null,
                  quoteSymbol: "USD",
                }),
                priceUnit: `USD per ${asset.symbol}`,
                items: Object.freeze(
                  fact.value.candles.slice(-pageSize).map((candle) =>
                    Object.freeze({
                      openTime: candle.openTime,
                      closeTime: new Date(
                        Date.parse(candle.openTime) + intervalSeconds * 1_000,
                      ).toISOString(),
                      open: candle.open,
                      high: candle.high,
                      low: candle.low,
                      close: candle.close,
                      volume: candle.volume,
                      swapCount: null,
                    }),
                  ),
                ),
              }),
              contractVersion: v2ContractVersion,
            });
          }
          // A Provider failure falls through to the indexer derivation, which
          // is labelled as such; the Provider reason is not silently dropped
          // because the derived block carries its own source.
        }
      }

      const checkpoint = await input.indexerRepository.getCheckpoint(
        "pool_event",
        input.chainId,
      );
      if (checkpoint === null) {
        return unavailable(marketReasonCodes.poolIndexerNotStarted);
      }
      const nowMs = now().getTime();
      const toTimestamp = new Date(nowMs).toISOString();
      const fromTimestamp = new Date(
        nowMs -
          (nowMs % (intervalSeconds * 1_000)) -
          (pageSize - 1) * intervalSeconds * 1_000,
      ).toISOString();

      for (const pool of pools) {
        const assetIsToken0 = pool.token0AssetId === asset.assetId;
        const quoteAssetId = assetIsToken0
          ? pool.token1AssetId
          : pool.token0AssetId;
        const quote = await input.registry.getAsset(quoteAssetId);
        if (quote === null) {
          continue;
        }
        const decimals0 = assetIsToken0 ? asset.decimals : quote.decimals;
        const decimals1 = assetIsToken0 ? quote.decimals : asset.decimals;
        const buckets = await input.indexerRepository.aggregateSwapCandles({
          poolId: pool.poolId,
          intervalSeconds,
          assetIsToken0,
          fromTimestamp,
          toTimestamp,
        });
        if (buckets.length === 0) {
          continue;
        }
        const items: CandleProjection[] = [];
        for (const bucket of buckets) {
          const price = (sqrt: string): string | null =>
            sqrtPriceX96ToAssetPrice({
              sqrtPriceX96: BigInt(sqrt),
              decimals0,
              decimals1,
              assetIsToken0,
            });
          const open = price(bucket.openSqrtPriceX96);
          const close = price(bucket.closeSqrtPriceX96);
          // Price is monotonic in sqrtPriceX96 for token0 and inverse for
          // token1, so the extremes swap orientation with the asset.
          const high = price(
            assetIsToken0 ? bucket.highSqrtPriceX96 : bucket.lowSqrtPriceX96,
          );
          const low = price(
            assetIsToken0 ? bucket.lowSqrtPriceX96 : bucket.highSqrtPriceX96,
          );
          if (
            open === null ||
            close === null ||
            high === null ||
            low === null
          ) {
            continue;
          }
          items.push(
            Object.freeze({
              openTime: bucket.bucketStart,
              closeTime: new Date(
                Date.parse(bucket.bucketStart) + intervalSeconds * 1_000,
              ).toISOString(),
              open,
              high,
              low,
              close,
              volume: formatDecimalAmount(
                BigInt(bucket.volumeRaw),
                asset.decimals,
              ),
              swapCount: bucket.swapCount,
            }),
          );
        }
        return Object.freeze({
          assetId: asset.assetId,
          interval,
          candles: Object.freeze({
            status: "available" as const,
            quality: "derived" as const,
            source: "loop_indexer" as const,
            fetchedAt: checkpoint.updatedAt,
            labelKey: derivedCandleLabelKey,
            pool: Object.freeze({
              address: pool.address,
              protocol: pool.protocol,
              quoteAssetId: quote.assetId,
              quoteSymbol: quote.symbol,
            }),
            priceUnit: `${quote.symbol} per ${asset.symbol}`,
            items: Object.freeze(items),
          }),
          contractVersion: v2ContractVersion,
        });
      }
      return unavailable(marketReasonCodes.noSwapsInRange);
    },

    async getTrades({ principal, assetId, cursor, limit }) {
      const asset = await requireAsset(assetId);
      const codec = input.cursorCodec;
      if (codec === null) {
        throw V2ApiError.capabilityUnavailable();
      }
      if (cursor !== undefined && limit !== undefined) {
        throw V2ApiError.invalidRequest();
      }
      const unavailable = (reasonCode: string): MarketTradesResource =>
        Object.freeze({
          assetId: asset.assetId,
          trades: unavailableBlock(reasonCode),
          contractVersion: v2ContractVersion,
        });
      if (asset.status === "blocked") {
        return unavailable("ASSET_BLOCKED");
      }
      if (asset.address === null) {
        return unavailable(marketReasonCodes.nativeAssetUnsupported);
      }
      const pools = poolsForAsset(
        await input.registry.listPools(input.chainId),
        asset.assetId,
      );
      if (pools.length === 0) {
        return unavailable(marketReasonCodes.poolNotRegistered);
      }
      const checkpoint = await input.indexerRepository.getCheckpoint(
        "pool_event",
        input.chainId,
      );
      if (checkpoint === null) {
        return unavailable(marketReasonCodes.poolIndexerNotStarted);
      }

      const filter = `asset=${asset.assetId}`;
      let pageSize: number = tradeLimits.default;
      let beforeBlockNumber: string | undefined;
      let beforeLogIndex: number | undefined;
      if (typeof cursor === "string") {
        let continuation;
        try {
          continuation = codec.decode({
            ownerId: principal.userId,
            route: tradesCursorRoute,
            filter,
            cursor,
          });
        } catch (error) {
          if (error instanceof InvalidV2CursorError) {
            throw V2ApiError.invalidRequest();
          }
          throw error;
        }
        const block = continuation["block"];
        const log = continuation["log"];
        const size = continuation["limit"];
        if (
          typeof block !== "string" ||
          typeof log !== "number" ||
          typeof size !== "number"
        ) {
          throw V2ApiError.invalidRequest();
        }
        beforeBlockNumber = block;
        beforeLogIndex = log;
        pageSize = size;
      } else if (limit !== undefined) {
        if (
          typeof limit !== "number" ||
          !Number.isInteger(limit) ||
          limit < 1 ||
          limit > tradeLimits.maximum
        ) {
          throw V2ApiError.invalidRequest();
        }
        pageSize = limit;
      } else if (cursor !== undefined) {
        throw V2ApiError.invalidRequest();
      }

      const poolsById = new Map(pools.map((pool) => [pool.poolId, pool]));
      const quoteCache = new Map<string, AssetRecord | null>();
      const page = await input.indexerRepository.listPoolSwaps({
        poolIds: pools.map((pool) => pool.poolId),
        limit: pageSize,
        ...(beforeBlockNumber === undefined ? {} : { beforeBlockNumber }),
        ...(beforeLogIndex === undefined ? {} : { beforeLogIndex }),
      });
      const head = await chainHead();
      const items: TradeProjection[] = [];
      for (const swap of page.items) {
        const pool = poolsById.get(swap.poolId);
        if (pool === undefined) {
          continue;
        }
        const projected = await projectTrade(
          swap,
          pool,
          asset,
          quoteCache,
          head,
        );
        if (projected !== null) {
          items.push(projected);
        }
      }
      const last = page.items.at(-1);
      const nextCursor =
        page.hasMore && last !== undefined
          ? codec.encode({
              ownerId: principal.userId,
              route: tradesCursorRoute,
              filter,
              continuation: {
                block: last.blockNumber,
                log: last.logIndex,
                limit: pageSize,
              },
            })
          : null;
      return Object.freeze({
        assetId: asset.assetId,
        trades: Object.freeze({
          status: "available" as const,
          source: "loop_indexer" as const,
          items: Object.freeze(items),
          nextCursor,
          freshness: Object.freeze({
            indexerBlockNumber: checkpoint.lastBlockNumber,
            headBlockNumber:
              head === null ? null : head.blockNumber.toString(10),
            lagBlocks:
              head === null
                ? null
                : Math.max(
                    0,
                    Number(
                      head.blockNumber - BigInt(checkpoint.lastBlockNumber),
                    ),
                  ),
            observedAt: head?.observedAt ?? now().toISOString(),
          }),
        }),
        contractVersion: v2ContractVersion,
      });

      async function projectTrade(
        swap: IndexedPoolEventRecord,
        pool: PoolRecord,
        base: AssetRecord,
        cache: Map<string, AssetRecord | null>,
        chainHeadValue: { readonly blockNumber: bigint } | null,
      ): Promise<TradeProjection | null> {
        const assetIsToken0 = pool.token0AssetId === base.assetId;
        const quoteAssetId = assetIsToken0
          ? pool.token1AssetId
          : pool.token0AssetId;
        let quote = cache.get(quoteAssetId);
        if (quote === undefined) {
          quote = await input.registry.getAsset(quoteAssetId);
          cache.set(quoteAssetId, quote);
        }
        if (
          quote === null ||
          swap.amount0 === null ||
          swap.amount1 === null ||
          swap.sqrtPriceX96 === null
        ) {
          return null;
        }
        const amountAssetRaw = BigInt(
          assetIsToken0 ? swap.amount0 : swap.amount1,
        );
        const amountQuoteRaw = BigInt(
          assetIsToken0 ? swap.amount1 : swap.amount0,
        );
        const absolute = (value: bigint): bigint =>
          value < 0n ? -value : value;
        const confirmations =
          chainHeadValue === null
            ? null
            : Math.max(
                0,
                Number(chainHeadValue.blockNumber - BigInt(swap.blockNumber)) +
                  1,
              );
        const status: TradeProjection["status"] = swap.removed
          ? "reorged"
          : confirmations !== null &&
              confirmations >= input.readClient.confirmations
            ? "confirmed"
            : "pending";
        return Object.freeze({
          transactionHash: swap.transactionHash,
          logIndex: swap.logIndex,
          blockNumber: swap.blockNumber,
          blockHash: swap.blockHash,
          blockTimestamp: swap.blockTimestamp,
          confirmations,
          status,
          // A negative asset amount means the pool paid the asset out: the
          // counterparty bought it.
          direction: amountAssetRaw < 0n ? "buy" : "sell",
          amountAsset: formatDecimalAmount(
            absolute(amountAssetRaw),
            base.decimals,
          ),
          amountQuote: formatDecimalAmount(
            absolute(amountQuoteRaw),
            quote.decimals,
          ),
          quoteAssetId: quote.assetId,
          quoteSymbol: quote.symbol,
          priceAfter: sqrtPriceX96ToAssetPrice({
            sqrtPriceX96: BigInt(swap.sqrtPriceX96),
            decimals0: assetIsToken0 ? base.decimals : quote.decimals,
            decimals1: assetIsToken0 ? quote.decimals : base.decimals,
            assetIsToken0,
          }),
          poolAddress: pool.address,
          sender: swap.payload["sender"] ?? null,
          recipient: swap.payload["recipient"] ?? null,
        });
      }
    },

    async getHolders({ assetId, signal }) {
      const asset = await requireAsset(assetId);
      let holderCount: MarketFactProjection;
      if (asset.address === null || asset.status === "blocked") {
        holderCount = unavailableFact(
          asset.status === "blocked"
            ? "ASSET_BLOCKED"
            : marketReasonCodes.nativeAssetUnsupported,
        );
      } else {
        const fact = await input.facts.readTokenSecurity(
          asset.address,
          signal === undefined ? {} : { signal },
        );
        holderCount =
          fact.value === null || fact.fetchedAt === null
            ? unavailableFact(
                fact.reasonCode ?? marketReasonCodes.providerUnreachable,
              )
            : fact.value.holderCount === null
              ? unavailableFact(marketReasonCodes.factMissing)
              : availableFact({
                  value: fact.value.holderCount,
                  source: fact.source,
                  fetchedAt: fact.fetchedAt,
                  ttlSeconds: fact.ttlSeconds,
                  quality: fact.quality === "stale" ? "stale" : "fresh",
                  reasonCode: fact.reasonCode,
                });
      }
      return Object.freeze({
        assetId: asset.assetId,
        holderCount,
        distribution: unavailableBlock(
          marketReasonCodes.holderDistributionUnsupported,
        ),
        contractVersion: v2ContractVersion,
      });
    },

    async getNewPairs({ signal }) {
      const fact = await input.facts.readNewPools(
        signal === undefined ? {} : { signal },
      );
      if (fact.value === null || fact.fetchedAt === null) {
        return Object.freeze({
          newPairs: unavailableBlock(
            fact.reasonCode ?? marketReasonCodes.providerUnreachable,
          ),
          riskScreening: unavailableBlock(
            marketReasonCodes.goplusNotConfigured,
          ),
          contractVersion: v2ContractVersion,
        });
      }
      const readable = await input.registry.listReadableAssets(input.chainId);
      const byAddress = new Map(
        readable
          .filter((asset) => asset.address !== null)
          .map((asset) => [asset.address as string, asset.assetId]),
      );
      return Object.freeze({
        newPairs: Object.freeze({
          status: "available" as const,
          source: fact.source,
          fetchedAt: fact.fetchedAt,
          ttlSeconds: fact.ttlSeconds,
          quality:
            fact.quality === "stale" ? ("stale" as const) : ("fresh" as const),
          reasonCode: fact.reasonCode,
          items: Object.freeze(
            fact.value.pools.map((pool) =>
              Object.freeze({
                poolAddress: pool.poolAddress,
                dexId: pool.dexId,
                name: pool.name,
                baseTokenAddress: pool.baseTokenAddress,
                quoteTokenAddress: pool.quoteTokenAddress,
                registryAssetId:
                  pool.baseTokenAddress === null
                    ? null
                    : (byAddress.get(pool.baseTokenAddress) ?? null),
                createdAt: pool.createdAt,
                reserveUsd: pool.reserveUsd,
                volumeH24Usd: pool.volumeH24Usd,
              }),
            ),
          ),
        }),
        riskScreening: unavailableBlock(marketReasonCodes.goplusNotConfigured),
        contractVersion: v2ContractVersion,
      });
    },

    getSmartMoney() {
      return Object.freeze({
        smartMoney: unavailableBlock(marketReasonCodes.smartMoneyDeferred),
        contractVersion: v2ContractVersion,
      });
    },
  };
  return Object.freeze(service);
}
