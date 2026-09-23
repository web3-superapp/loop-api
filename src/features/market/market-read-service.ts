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
import type { AccountWalletRepository } from "../../database/account-wallet-repository.js";
import {
  bscWrappedNativeAddress,
  bscWrappedNativeAssetId,
} from "./market-contract.js";
import type { BscReadClient } from "../../integrations/bsc/rpc-client.js";
import type {
  PoolOhlcvSnapshot,
  PoolRef,
  TokenPairSnapshot,
  TokenPairsSnapshot,
} from "../../integrations/market/market-data-provider.js";
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
  providerLookupSourceKind,
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
  type UnlistedTokenFact,
} from "./market-fact-service.js";
import {
  UnlistedTokenLookupQuotaUnavailableError,
  UnlistedTokenLookupRateLimitedError,
  type UnlistedTokenLookupQuota,
} from "./unlisted-token-lookup-quota.js";
import { observedHolderCount } from "../../integrations/market/goplus-adapter.js";
import {
  observedLogoImage,
  observedLogoImageFromPairs,
  projectTokenLogo,
  projectTokenLogoForAddress,
  projectTokenLogoForAssetId,
  type ObservedLogoImage,
  type TokenLogoProjection,
} from "./token-logo.js";

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
  /** Display picture of the asset (Decision 0072); never an identifier. */
  readonly logo: TokenLogoProjection;
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
  /**
   * The new-pairs card (Decision 0053 §3): the same `readNewPools` fact the
   * new-pairs page reads, so `omittedCount` is that page's value. Available
   * means the page has data right now, not merely that a Provider exists.
   */
  readonly newPairs:
    | { readonly status: "available"; readonly omittedCount: number }
    | UnavailableBlock;
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

/**
 * An asset the registry does not know, described from a Provider lookup
 * (Decision 0058). `status` is always `unregistered`; identity fields the
 * Provider did not report are `null` (DexScreener never reports decimals),
 * and `source` names the Provider and when it answered. The shape keeps the
 * registered projection's keys so one client codec can read both.
 */
export interface UnregisteredAssetProjection {
  readonly assetId: string;
  readonly chainId: string;
  readonly address: string;
  readonly symbol: string | null;
  readonly name: string | null;
  readonly decimals: number | null;
  readonly status: "unregistered";
  readonly source: {
    readonly kind: typeof providerLookupSourceKind;
    readonly provider: MarketSource;
    readonly fetchedAt: string;
    readonly ttlSeconds: number;
    readonly quality: "fresh" | "stale";
    readonly blockNumber: null;
    readonly verifiedAt: null;
  };
  readonly updatedAt: string;
}

export interface MarketAssetResource {
  /**
   * Registry projection for a registered asset; the Provider-described
   * projection for an unregistered address; or `unavailable` when the
   * address is unregistered and no Provider could describe it right now.
   */
  readonly asset:
    AssetProjection | UnregisteredAssetProjection | UnavailableBlock;
  readonly capability: AssetCapabilityProjection;
  readonly price: MarketFactProjection;
  readonly priceChange24h: MarketFactProjection;
  readonly liquidityUsd: MarketFactProjection;
  readonly volume24h: MarketFactProjection;
  readonly marketCap: MarketFactProjection;
  readonly fdv: MarketFactProjection;
  readonly primaryPair: PrimaryPairProjection | null;
  /**
   * The asset's logo (Decision 0072): DexScreener's image from the primary
   * pair when it reported one, else the Trust Wallet rule URL.
   */
  readonly logo: TokenLogoProjection;
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
  /** True for the bucket whose closeTime is still in the future. */
  readonly isOpen: boolean;
}

/** Origin of the pool a candle series was read from (Decision 0064). */
export type CandlePoolOrigin = "registry" | "provider";

export interface MarketCandlesResource {
  readonly assetId: string;
  readonly interval: CandleInterval;
  readonly candles:
    | {
        readonly status: "available";
        /** `proxied`: the native asset charted through `proxyAsset` (WBNB). */
        readonly quality: "fresh" | "stale" | "derived" | "proxied";
        readonly source: MarketSource;
        readonly fetchedAt: string;
        readonly labelKey: string | null;
        /** The asset whose pool actually produced the candles; null unless proxied. */
        readonly proxyAsset: string | null;
        readonly pool: {
          readonly address: string;
          readonly protocol: string;
          /**
           * Where the charted pool came from (Decision 0064): `registry` is a
           * pool LOOP has registered and indexes; `provider` is the top pool
           * the market Provider reports for the token, which LOOP does not
           * index and cannot derive trades from.
           */
          readonly origin: CandlePoolOrigin;
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
  /** True when the swap's sender or recipient is one of the caller's wallets. */
  readonly isOwn: boolean;
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
  /**
   * The Provider's pool identifier (Decision 0052 §3): a contract address
   * for V2/V3-style pools, a 32-byte pool id for Uniswap V4 pools inside the
   * singleton. A pool id is never dressed up as an address.
   */
  readonly poolRef: PoolRef;
  readonly dexId: string;
  readonly name: string;
  readonly baseTokenAddress: string | null;
  readonly quoteTokenAddress: string | null;
  readonly registryAssetId: string | null;
  /** The base token's logo (Decision 0072); `unavailable` without a base token address. */
  readonly logo: TokenLogoProjection;
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
        /** Rows whose pool identifier is neither an address nor a pool id; both known forms are listed. */
        readonly omittedCount: number;
      }
    | UnavailableBlock;
  readonly riskScreening: UnavailableBlock;
  readonly contractVersion: typeof v2ContractVersion;
}

export interface MarketSmartMoneyResource {
  readonly smartMoney: UnavailableBlock;
  readonly contractVersion: typeof v2ContractVersion;
}

/**
 * Caller facts an unregistered-address lookup needs for its quota
 * (Decision 0058). A registered asset never consumes the quota.
 */
export interface LookupCaller {
  readonly principal: AuthenticatedLoopPrincipal;
  readonly canonicalClientIp: string;
}

export interface MarketReadService {
  getOverview(input: {
    readonly principal: AuthenticatedLoopPrincipal;
    readonly signal?: AbortSignal;
  }): Promise<MarketOverviewResource>;
  getAsset(input: {
    readonly assetId: unknown;
    readonly caller: LookupCaller;
    readonly signal?: AbortSignal;
  }): Promise<MarketAssetResource>;
  getCandles(input: {
    readonly assetId: unknown;
    readonly interval: unknown;
    readonly limit?: unknown;
    readonly caller: LookupCaller;
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
  /** Account wallets for `isOwn` on trades; `null` when the wallet module is not composed. */
  readonly wallets: AccountWalletRepository | null;
  readonly readClient: BscReadClient;
  readonly cursorCodec: V2CursorCodec | null;
  /**
   * Quota for unregistered-address lookups (Decision 0058); `null` when the
   * quota secret is not configured, which fails those lookups closed with
   * `CAPABILITY_UNAVAILABLE` while registered assets keep working.
   */
  readonly lookupQuota: UnlistedTokenLookupQuota | null;
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
  /**
   * The image DexScreener reported on one of the asset's own base pairs,
   * stamped with the fact's observation time; `null` when none, when the
   * fact is unavailable, or when the fact is a proxy's (the proxy's picture
   * is not the asset's).
   */
  readonly logoImage: ObservedLogoImage | null;
}

function pairFactsFromSnapshot(
  fact: CachedFact<{
    readonly tokenAddress: string;
    readonly pairs: readonly TokenPairSnapshot[];
  }>,
  proxied = false,
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
      logoImage: null,
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
  const quality = proxied
    ? "proxied"
    : fact.quality === "stale"
      ? "stale"
      : "fresh";
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
    // A proxied fact is the wrapped token's; its picture is not the native
    // asset's, so the native asset takes the rule URL instead.
    logoImage: proxied
      ? null
      : observedLogoImageFromPairs({
          tokenAddress: fact.value.tokenAddress,
          pairs: fact.value.pairs,
          preferredPair: pair,
          observedAt: fact.fetchedAt,
        }),
  });
}

/**
 * One Provider OHLCV fact projected as the candles block, for every surface
 * that charts a token from a Provider pool: a registered pool, the top pool
 * the Provider reports for a registered token LOOP has no pool for, and the
 * top pool of an unregistered address (Decisions 0034, 0058, 0064). The pool
 * is always named together with its `origin`, so a client can tell a pool
 * LOOP knows from one only the Provider knows.
 *
 * `null` when the Provider fact carries no snapshot; the caller decides
 * whether that falls through to another source or closes the block.
 */
function providerCandlesResource(input: {
  readonly assetId: string;
  readonly interval: CandleInterval;
  readonly intervalSeconds: number;
  readonly pageSize: number;
  readonly fact: CachedFact<PoolOhlcvSnapshot>;
  readonly pool: {
    readonly address: string;
    readonly protocol: string;
    readonly origin: CandlePoolOrigin;
  };
  /** Asset whose pool produced the candles when it is not the asked asset. */
  readonly proxyAsset: string | null;
  /** Symbol the price is quoted for; the address when no symbol is known. */
  readonly pricedSymbol: string;
  readonly nowMs: number;
}): MarketCandlesResource | null {
  const { fact } = input;
  if (fact.value === null || fact.fetchedAt === null) {
    return null;
  }
  const closeTimeMs = (openTime: string): number =>
    Date.parse(openTime) + input.intervalSeconds * 1_000;
  return Object.freeze({
    assetId: input.assetId,
    interval: input.interval,
    candles: Object.freeze({
      status: "available" as const,
      quality:
        input.proxyAsset !== null
          ? ("proxied" as const)
          : fact.quality === "stale"
            ? ("stale" as const)
            : ("fresh" as const),
      source: fact.source,
      fetchedAt: fact.fetchedAt,
      labelKey: null,
      proxyAsset: input.proxyAsset,
      pool: Object.freeze({
        address: input.pool.address,
        protocol: input.pool.protocol,
        origin: input.pool.origin,
        quoteAssetId: null,
        quoteSymbol: "USD",
      }),
      priceUnit: `USD per ${input.pricedSymbol}`,
      items: Object.freeze(
        fact.value.candles.slice(-input.pageSize).map((candle) =>
          Object.freeze({
            openTime: candle.openTime,
            closeTime: new Date(closeTimeMs(candle.openTime)).toISOString(),
            open: candle.open,
            high: candle.high,
            low: candle.low,
            close: candle.close,
            volume: candle.volume,
            swapCount: null,
            isOpen: closeTimeMs(candle.openTime) > input.nowMs,
          }),
        ),
      ),
    }),
    contractVersion: v2ContractVersion,
  });
}

/**
 * Holder count as a fact: GoPlus reports "0" for tokens it keeps no holder
 * index for (walkthrough B-9: BSC USDT), and a positive-supply token cannot
 * have zero holders, so "0" is treated as not reported — here as well as
 * at the adapter boundary, because a snapshot cached before that rule may
 * still carry the placeholder for its TTL.
 */
function holderCountFact(
  input: Omit<Parameters<typeof availableFact>[0], "value"> & {
    readonly reported: string | null;
  },
): MarketFactProjection {
  const { reported, ...provenance } = input;
  const value = observedHolderCount(reported);
  return value === null
    ? unavailableFact(marketReasonCodes.factMissing)
    : availableFact({ ...provenance, value });
}

export function createMarketReadService(
  input: CreateMarketReadServiceInput,
): MarketReadService {
  const now = input.now ?? ((): Date => new Date());
  const createRecommendationId = input.createRecommendationId ?? randomUUID;

  async function requireAsset(assetId: unknown): Promise<AssetRecord> {
    const resolved = await resolveAsset(assetId);
    if (resolved.record === null) {
      throw V2ApiError.notFound();
    }
    return resolved.record;
  }

  /**
   * Registry-first resolution. An address the registry does not know is
   * returned with `record: null` so the caller can decide whether the
   * surface admits a Provider lookup (Decision 0058); the native asset can
   * only ever come from the registry.
   */
  async function resolveAsset(assetId: unknown): Promise<{
    readonly assetId: string;
    readonly record: AssetRecord | null;
    readonly address: string;
  }> {
    if (!isAssetId(assetId)) {
      throw V2ApiError.invalidRequest();
    }
    const parsed = decomposeAssetId(assetId);
    if (parsed.chainId !== input.chainId) {
      throw V2ApiError.fromCode("CHAIN_MISMATCH");
    }
    const record = await input.registry.getAsset(assetId);
    if (record !== null) {
      return { assetId, record, address: record.address ?? "" };
    }
    if (parsed.address === null) {
      throw V2ApiError.notFound();
    }
    return { assetId, record: null, address: parsed.address };
  }

  /**
   * Consume the lookup quota, then read the Provider description of an
   * unregistered address. Quota exhaustion is `RATE_LIMITED`; a missing
   * quota runtime is `CAPABILITY_UNAVAILABLE`; a Provider that answered
   * "no such token" is `NOT_FOUND`.
   */
  async function lookupUnregistered(
    address: string,
    caller: LookupCaller,
    signal: AbortSignal | undefined,
  ): Promise<UnlistedTokenFact> {
    if (input.lookupQuota === null) {
      throw V2ApiError.capabilityUnavailable();
    }
    try {
      await input.lookupQuota.consume({
        userId: caller.principal.userId,
        canonicalClientIp: caller.canonicalClientIp,
        signal: signal ?? new AbortController().signal,
      });
    } catch (error) {
      if (error instanceof UnlistedTokenLookupRateLimitedError) {
        throw V2ApiError.rateLimited();
      }
      if (error instanceof UnlistedTokenLookupQuotaUnavailableError) {
        throw V2ApiError.capabilityUnavailable();
      }
      throw error;
    }
    const fact = await input.facts.readUnlistedToken(
      address,
      signal === undefined ? {} : { signal },
    );
    if (fact.notFound) {
      throw V2ApiError.notFound();
    }
    return fact;
  }

  function unregisteredPairFacts(fact: UnlistedTokenFact): PairFacts {
    const market = fact.market;
    if (market.value === null || market.fetchedAt === null) {
      return pairFactsFromSnapshot({
        value: null,
        source: market.source,
        fetchedAt: null,
        ttlSeconds: market.ttlSeconds,
        quality: "unavailable",
        reasonCode: market.reasonCode ?? marketReasonCodes.providerUnreachable,
        rawDigest: null,
      });
    }
    const fetchedAt = market.fetchedAt;
    const quality = market.quality === "stale" ? "stale" : "fresh";
    const project = (value: string | null): MarketFactProjection =>
      value === null
        ? unavailableFact(marketReasonCodes.factMissing)
        : availableFact({
            value,
            source: market.source,
            fetchedAt,
            ttlSeconds: market.ttlSeconds,
            quality,
            reasonCode: market.reasonCode,
          });
    const value = market.value;
    return Object.freeze({
      price: project(value.priceUsd),
      priceChange24h: project(value.priceChangeH24),
      liquidityUsd: project(value.liquidityUsd),
      volume24h: project(value.volumeH24),
      marketCap: project(value.marketCap),
      fdv: project(value.fdv),
      primaryPair:
        value.primaryPair === null
          ? null
          : Object.freeze({
              pairAddress: value.primaryPair.pairAddress,
              dexId: value.primaryPair.dexId,
              labels: value.primaryPair.labels,
              quoteTokenAddress: value.primaryPair.quoteTokenAddress,
              quoteTokenSymbol: value.primaryPair.quoteTokenSymbol,
              pairCreatedAt: value.primaryPair.pairCreatedAt,
            }),
      volumeForOrdering: value.volumeH24,
      logoImage: observedLogoImage(value.imageUrl, fetchedAt),
    });
  }

  function projectUnregisteredAsset(
    assetId: string,
    address: string,
    fact: UnlistedTokenFact,
  ): UnregisteredAssetProjection | UnavailableBlock {
    const identity = fact.identity;
    if (identity.value === null || identity.fetchedAt === null) {
      return unavailableBlock(
        identity.reasonCode ?? marketReasonCodes.providerUnreachable,
      );
    }
    return Object.freeze({
      assetId,
      chainId: input.chainId,
      address,
      symbol: identity.value.symbol,
      name: identity.value.name,
      decimals: identity.value.decimals,
      status: "unregistered" as const,
      source: Object.freeze({
        kind: providerLookupSourceKind,
        provider: identity.source,
        fetchedAt: identity.fetchedAt,
        ttlSeconds: identity.ttlSeconds,
        quality:
          identity.quality === "stale"
            ? ("stale" as const)
            : ("fresh" as const),
        blockNumber: null,
        verifiedAt: null,
      }),
      updatedAt: identity.fetchedAt,
    });
  }

  async function securityFor(
    address: string,
    signal: AbortSignal | undefined,
  ): Promise<{
    readonly security: MarketAssetResource["security"];
    readonly holderCount: MarketFactProjection;
  }> {
    const fact = await input.facts.readTokenSecurity(
      address,
      signal === undefined ? {} : { signal },
    );
    if (fact.value === null || fact.fetchedAt === null) {
      const reasonCode =
        fact.reasonCode ?? marketReasonCodes.providerUnreachable;
      return {
        security: unavailableBlock(reasonCode),
        holderCount: unavailableFact(reasonCode),
      };
    }
    const fetchedAt = fact.fetchedAt;
    const quality = fact.quality === "stale" ? "stale" : "fresh";
    return {
      security: Object.freeze({
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
      }),
      holderCount: holderCountFact({
        reported: fact.value.holderCount,
        source: fact.source,
        fetchedAt,
        ttlSeconds: fact.ttlSeconds,
        quality,
        reasonCode: fact.reasonCode,
      }),
    };
  }

  async function pairFactsFor(
    asset: AssetRecord,
    signal: AbortSignal | undefined,
    prefetched?: ReadonlyMap<string, CachedFact<TokenPairsSnapshot>>,
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
    // The native asset is priced through the wrapped native token and
    // published as `proxied`; nothing else is ever substituted.
    const address = asset.address ?? bscWrappedNativeAddress;
    const fact =
      prefetched?.get(address) ??
      (await input.facts.readTokenPairs(
        address,
        signal === undefined ? {} : { signal },
      ));
    return pairFactsFromSnapshot(fact, asset.address === null);
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

  /**
   * Chart a registered token LOOP has no registered pool for (Decision
   * 0064), through the Provider top-pool path of Decision 0058: the token
   * lookup names the deepest pool the Provider knows, and the OHLCV of that
   * pool is the chart. The enumeration quota of Decision 0058 is not
   * consumed — the registry is a bounded set the caller did not choose, so
   * a registered asset id probes no Provider coverage.
   *
   * "The Provider knows no pool for it either" keeps the reason code
   * `MARKET_POOL_NOT_REGISTERED`, so a client that already handles that
   * block needs no new case; a Provider that could not answer keeps its own
   * reason, because not knowing is not the same as there being nothing.
   */
  async function providerTopPoolCandles(args: {
    readonly assetId: string;
    readonly address: string;
    readonly symbol: string;
    readonly interval: CandleInterval;
    readonly intervalSeconds: number;
    readonly pageSize: number;
    readonly proxyAsset: string | null;
    readonly unavailable: (reasonCode: string) => MarketCandlesResource;
    readonly signal: AbortSignal | undefined;
  }): Promise<MarketCandlesResource> {
    const options = args.signal === undefined ? {} : { signal: args.signal };
    if (!input.facts.candlesProviderEnabled) {
      return args.unavailable(marketReasonCodes.poolNotRegistered);
    }
    const lookup = await input.facts.readUnlistedToken(args.address, options);
    const pair = lookup.market.value?.primaryPair ?? null;
    if (pair === null) {
      const reasonCode = lookup.market.reasonCode;
      return args.unavailable(
        lookup.market.value === null &&
          reasonCode !== null &&
          reasonCode !== marketReasonCodes.tokenNotFound
          ? reasonCode
          : marketReasonCodes.poolNotRegistered,
      );
    }
    const fact = await input.facts.readPoolOhlcv(
      {
        poolAddress: pair.pairAddress,
        timeframe: args.interval,
        limit: args.pageSize,
        tokenAddress: args.address,
      },
      options,
    );
    return (
      providerCandlesResource({
        assetId: args.assetId,
        interval: args.interval,
        intervalSeconds: args.intervalSeconds,
        pageSize: args.pageSize,
        fact,
        pool: {
          address: pair.pairAddress,
          protocol: pair.dexId,
          origin: "provider",
        },
        proxyAsset: args.proxyAsset,
        pricedSymbol: args.symbol,
        nowMs: now().getTime(),
      }) ??
      args.unavailable(fact.reasonCode ?? marketReasonCodes.providerUnreachable)
    );
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
      // One batched Provider read covers the watchlist and the trending scan.
      const scanned = readable.slice(0, trendingScanLimit);
      const watchlistIds = new Set<string>();
      if (input.watchlist !== null) {
        for (const group of (await input.watchlist.get(principal.userId))
          .groups) {
          for (const item of group.items) {
            watchlistIds.add(item.assetId);
          }
        }
      }
      const prefetched = await input.facts.readTokenPairsBatch(
        [
          ...scanned,
          ...readable.filter((asset) => watchlistIds.has(asset.assetId)),
        ].map((asset) => asset.address ?? bscWrappedNativeAddress),
        signal === undefined ? {} : { signal },
      );

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
                  // The rule URL follows from the address alone; a row the
                  // registry cannot vouch for still shows its picture.
                  logo: projectTokenLogoForAssetId(item.assetId),
                  price: unavailableFact("ASSET_NOT_READABLE"),
                  priceChange24h: unavailableFact("ASSET_NOT_READABLE"),
                }),
              );
              continue;
            }
            const facts = await pairFactsFor(asset, signal, prefetched);
            rows.push(
              Object.freeze({
                assetId: asset.assetId,
                asset: summarize(asset),
                logo: projectTokenLogo({
                  chainId: asset.chainId,
                  address: asset.address,
                  providerImage: facts.logoImage,
                }),
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
      let lastTrendingReason: string | null = null;
      for (const asset of scanned) {
        if (asset.address === null) {
          continue;
        }
        const facts = await pairFactsFor(asset, signal, prefetched);
        if (facts.volumeForOrdering === null) {
          lastTrendingReason =
            facts.volume24h.reasonCode ?? marketReasonCodes.factMissing;
          continue;
        }
        candidates.push(
          Object.freeze({
            assetId: asset.assetId,
            asset: summarize(asset),
            logo: projectTokenLogo({
              chainId: asset.chainId,
              address: asset.address,
              providerImage: facts.logoImage,
            }),
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
          ? unavailableBlock(
              lastTrendingReason ?? marketReasonCodes.dexscreenerDisabled,
            )
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

      let newPairs: MarketOverviewResource["newPairs"];
      if (!input.facts.candlesProviderEnabled) {
        newPairs = unavailableBlock(marketReasonCodes.geckoterminalDisabled);
      } else {
        const fact = await input.facts.readNewPools(
          signal === undefined ? {} : { signal },
        );
        newPairs =
          fact.value === null || fact.fetchedAt === null
            ? unavailableBlock(
                fact.reasonCode ?? marketReasonCodes.providerUnreachable,
              )
            : Object.freeze({
                status: "available" as const,
                omittedCount: fact.value.omittedPoolCount,
              });
      }

      return Object.freeze({
        watchlist,
        trending,
        newPairs,
        smartMoney: unavailableBlock(marketReasonCodes.smartMoneyDeferred),
        observedAt,
        contractVersion: v2ContractVersion,
      });
    },

    async getAsset({ assetId, caller, signal }) {
      const resolved = await resolveAsset(assetId);
      if (resolved.record === null) {
        // Unregistered address (Decision 0058): quota, then Provider lookup.
        const lookup = await lookupUnregistered(
          resolved.address,
          caller,
          signal,
        );
        const projected = projectUnregisteredAsset(
          resolved.assetId,
          resolved.address,
          lookup,
        );
        const facts = unregisteredPairFacts(lookup);
        const goplus = await securityFor(resolved.address, signal);
        return Object.freeze({
          asset: projected,
          capability:
            projected.status === "unregistered"
              ? Object.freeze({
                  viewable: true,
                  swappable: false,
                  value: "viewable" as const,
                  reasonCode: marketReasonCodes.assetNotRegistered,
                })
              : Object.freeze({
                  viewable: false,
                  swappable: false,
                  value: "temporarily_unavailable" as const,
                  reasonCode: projected.reasonCode,
                }),
          price: facts.price,
          priceChange24h: facts.priceChange24h,
          liquidityUsd: facts.liquidityUsd,
          volume24h: facts.volume24h,
          marketCap: facts.marketCap,
          fdv: facts.fdv,
          primaryPair: facts.primaryPair,
          logo: projectTokenLogoForAssetId(resolved.assetId, facts.logoImage),
          community: unavailableBlock(marketReasonCodes.communityNotBound),
          security: goplus.security,
          holderCount: goplus.holderCount,
          contractVersion: v2ContractVersion,
        });
      }
      const asset = resolved.record;
      const chainReadable =
        (await input.readClient.verifyChain()) === "verified";
      let facts = await pairFactsFor(asset, signal);
      // The pairs Provider reported no usable pair for a registered token:
      // fall back to the same Provider top-pool lookup an unregistered
      // address uses (Decision 0064), so a token LOOP registered is never
      // read worse than one it does not know. The fallback is taken whole —
      // every fact then comes from that one snapshot with its own source,
      // never one field from each Provider. The native asset is excluded:
      // its facts must stay labelled `proxied` through WBNB (Decision 0050).
      if (
        facts.primaryPair === null &&
        asset.address !== null &&
        asset.status !== "blocked"
      ) {
        const fallback = unregisteredPairFacts(
          await input.facts.readUnlistedToken(
            asset.address,
            signal === undefined ? {} : { signal },
          ),
        );
        if (fallback.primaryPair !== null) {
          facts = fallback;
        }
      }

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
          holderCount = holderCountFact({
            reported: fact.value.holderCount,
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
        logo: projectTokenLogo({
          chainId: asset.chainId,
          address: asset.address,
          providerImage: facts.logoImage,
        }),
        community,
        security,
        holderCount,
        contractVersion: v2ContractVersion,
      });
    },

    async getCandles({ assetId, interval, limit, caller, signal }) {
      const resolved = await resolveAsset(assetId);
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
          assetId: resolved.assetId,
          interval,
          candles: unavailableBlock(reasonCode),
          contractVersion: v2ContractVersion,
        });
      const intervalSeconds = candleIntervalSeconds[interval];

      if (resolved.record === null) {
        // Unregistered address (Decision 0058): only Provider OHLCV of the
        // lookup's primary pair can chart it; there is no registered pool
        // to derive candles from, and nothing is derived from another
        // source.
        const lookup = await lookupUnregistered(
          resolved.address,
          caller,
          signal,
        );
        if (!input.facts.candlesProviderEnabled) {
          return unavailable(marketReasonCodes.poolNotRegistered);
        }
        const market = lookup.market;
        if (market.value === null) {
          return unavailable(
            market.reasonCode ?? marketReasonCodes.providerUnreachable,
          );
        }
        const pair = market.value.primaryPair;
        if (pair === null) {
          return unavailable(marketReasonCodes.pairNotFound);
        }
        const fact = await input.facts.readPoolOhlcv(
          {
            poolAddress: pair.pairAddress,
            timeframe: interval,
            limit: pageSize,
            tokenAddress: resolved.address,
          },
          signal === undefined ? {} : { signal },
        );
        return (
          providerCandlesResource({
            assetId: resolved.assetId,
            interval,
            intervalSeconds,
            pageSize,
            fact,
            pool: {
              address: pair.pairAddress,
              protocol: pair.dexId,
              origin: "provider",
            },
            proxyAsset: null,
            pricedSymbol: lookup.identity.value?.symbol ?? resolved.address,
            nowMs: now().getTime(),
          }) ??
          unavailable(fact.reasonCode ?? marketReasonCodes.providerUnreachable)
        );
      }
      const asset = resolved.record;
      if (asset.status === "blocked") {
        return unavailable("ASSET_BLOCKED");
      }
      // The native asset has no pool of its own. Its candles are the wrapped
      // native token's, published as `proxied` with the proxy named, the same
      // one-to-one proxy the price facts and the wallet valuation use
      // (Decision 0050). Nothing else is ever substituted.
      let proxy: AssetRecord | null = null;
      if (asset.address === null) {
        proxy = await input.registry.getAsset(bscWrappedNativeAssetId);
        if (
          proxy === null ||
          proxy.address === null ||
          proxy.status === "blocked"
        ) {
          return unavailable(marketReasonCodes.nativeAssetUnsupported);
        }
      }
      const priced = proxy ?? asset;
      const pricedAddress = priced.address;
      if (pricedAddress === null) {
        return unavailable(marketReasonCodes.nativeAssetUnsupported);
      }
      const proxyAssetId = proxy === null ? null : proxy.assetId;
      const pools = poolsForAsset(
        await input.registry.listPools(input.chainId),
        priced.assetId,
      );
      if (pools.length === 0) {
        // Registered, but LOOP has registered no pool for it. Registering a
        // token must never make it less readable than leaving it out of the
        // registry, so the chart comes from the same Provider top-pool read
        // an unregistered address uses (Decision 0064): same adapter, same
        // cache rows, same TTL. There is no derived path here — a pool LOOP
        // does not index produces no swap aggregate.
        return await providerTopPoolCandles({
          assetId: asset.assetId,
          address: pricedAddress,
          symbol: priced.symbol,
          interval,
          intervalSeconds,
          pageSize,
          proxyAsset: proxyAssetId,
          unavailable,
          signal,
        });
      }

      // Provider path first: GeckoTerminal OHLCV in USD for the asset.
      if (input.facts.candlesProviderEnabled) {
        const pool = pools[0];
        if (pool !== undefined) {
          const fact = await input.facts.readPoolOhlcv(
            {
              poolAddress: pool.address,
              timeframe: interval,
              limit: pageSize,
              tokenAddress: pricedAddress,
            },
            signal === undefined ? {} : { signal },
          );
          const resource = providerCandlesResource({
            assetId: asset.assetId,
            interval,
            intervalSeconds,
            pageSize,
            fact,
            pool: {
              address: pool.address,
              protocol: pool.protocol,
              origin: "registry",
            },
            proxyAsset: proxyAssetId,
            pricedSymbol: priced.symbol,
            nowMs: now().getTime(),
          });
          if (resource !== null) {
            return resource;
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
        const assetIsToken0 = pool.token0AssetId === priced.assetId;
        const quoteAssetId = assetIsToken0
          ? pool.token1AssetId
          : pool.token0AssetId;
        const quote = await input.registry.getAsset(quoteAssetId);
        if (quote === null) {
          continue;
        }
        const decimals0 = assetIsToken0 ? priced.decimals : quote.decimals;
        const decimals1 = assetIsToken0 ? quote.decimals : priced.decimals;
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
                priced.decimals,
              ),
              swapCount: bucket.swapCount,
              isOpen:
                Date.parse(bucket.bucketStart) + intervalSeconds * 1_000 >
                nowMs,
            }),
          );
        }
        return Object.freeze({
          assetId: asset.assetId,
          interval,
          candles: Object.freeze({
            status: "available" as const,
            quality:
              proxy !== null ? ("proxied" as const) : ("derived" as const),
            source: "loop_indexer" as const,
            fetchedAt: checkpoint.updatedAt,
            labelKey: derivedCandleLabelKey,
            proxyAsset: proxyAssetId,
            pool: Object.freeze({
              address: pool.address,
              protocol: pool.protocol,
              origin: "registry" as const,
              quoteAssetId: quote.assetId,
              quoteSymbol: quote.symbol,
            }),
            priceUnit: `${quote.symbol} per ${priced.symbol}`,
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
      const ownAddresses = new Set(
        input.wallets === null
          ? []
          : (await input.wallets.list(principal.userId)).map(
              (wallet) => wallet.address,
            ),
      );
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
          isOwn:
            ownAddresses.has(swap.payload["sender"] ?? "") ||
            ownAddresses.has(swap.payload["recipient"] ?? ""),
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
            : holderCountFact({
                reported: fact.value.holderCount,
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
                poolRef: pool.poolRef,
                dexId: pool.dexId,
                name: pool.name,
                baseTokenAddress: pool.baseTokenAddress,
                quoteTokenAddress: pool.quoteTokenAddress,
                registryAssetId:
                  pool.baseTokenAddress === null
                    ? null
                    : (byAddress.get(pool.baseTokenAddress) ?? null),
                logo: projectTokenLogoForAddress(
                  input.chainId,
                  pool.baseTokenAddress,
                ),
                createdAt: pool.createdAt,
                reserveUsd: pool.reserveUsd,
                volumeH24Usd: pool.volumeH24Usd,
              }),
            ),
          ),
          omittedCount: fact.value.omittedPoolCount,
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
