import { z } from "zod";

import {
  normalizeDecimalString,
  InvalidMarketDecimalError,
} from "../../features/market/market-contract.js";
import {
  normalizeEvmAddress,
  InvalidChainIdentityError,
} from "../../features/chain/chain-contract.js";
import {
  marketPairsBatchLimit,
  MarketProviderError,
  type MarketPairsProvider,
  type PairSnapshot,
  type ProviderObservation,
  type ProviderReadOptions,
  type TokenPairSnapshot,
  type TokenPairsSnapshot,
} from "./market-data-provider.js";
import {
  createProviderHttpKernel,
  createRateLimiter,
  malformed,
  nodeProviderFetch,
  type ProviderFetch,
  type ProviderHttpKernel,
} from "./provider-http.js";

/**
 * DexScreener adapter (Decision 0034; provider-lock `dexscreener_service`,
 * VERIFIED, no credential).
 *
 * Three endpoints are used: `GET /token-pairs/v1/{chainId}/{tokenAddress}`,
 * `GET /tokens/v1/{chainId}/{addresses}`, and — for a reference pricing rule
 * that names one pool (Decision 0059) — `GET /latest/dex/pairs/{chainId}/
 * {pairAddress}`. All are documented at 300 requests per minute. The client-side throttle defaults to
 * that limit and can only be lowered. Every numeric field is kept as the exact
 * digit string DexScreener sent; nothing is rounded or summed here.
 */

export const dexscreenerBaseUrl = "https://api.dexscreener.com";
export const dexscreenerDocumentedRateLimitPerMinute = 300;
export const dexscreenerChainSlug = "bsc";

const lossyNumber = z.union([z.string(), z.number()]).nullable().optional();

const tokenSchema = z
  .object({
    address: z.string(),
    symbol: z.string().max(64).optional(),
    name: z.string().max(256).optional(),
  })
  .passthrough();

const pairSchema = z
  .object({
    chainId: z.string(),
    dexId: z.string().max(64),
    pairAddress: z.string(),
    labels: z.array(z.string().max(32)).optional(),
    baseToken: tokenSchema,
    quoteToken: tokenSchema,
    priceUsd: lossyNumber,
    priceNative: lossyNumber,
    liquidity: z
      .object({ usd: lossyNumber })
      .passthrough()
      .nullable()
      .optional(),
    volume: z.object({ h24: lossyNumber }).passthrough().nullable().optional(),
    priceChange: z
      .object({ h24: lossyNumber })
      .passthrough()
      .nullable()
      .optional(),
    fdv: lossyNumber,
    marketCap: lossyNumber,
    txns: z
      .object({
        h24: z
          .object({
            buys: z.union([z.string(), z.number()]),
            sells: z.union([z.string(), z.number()]),
          })
          .passthrough()
          .optional(),
      })
      .passthrough()
      .nullable()
      .optional(),
    pairCreatedAt: z.union([z.string(), z.number()]).nullable().optional(),
  })
  .passthrough();

const responseSchema = z.array(pairSchema);

/** `/latest/dex/pairs/{chain}/{pairId}` answers with a (possibly null) list. */
const pairResponseSchema = z
  .object({
    pairs: z.array(pairSchema).nullable().optional(),
    pair: pairSchema.nullable().optional(),
  })
  .passthrough();

function optionalDecimal(
  value: string | number | null | undefined,
): string | null {
  if (value === null || value === undefined) {
    return null;
  }
  // Only lossless digit strings are accepted; a JavaScript number here would
  // mean the transport lost precision, so it is refused rather than used.
  if (typeof value !== "string") {
    return malformed();
  }
  try {
    return normalizeDecimalString(value);
  } catch (error) {
    if (error instanceof InvalidMarketDecimalError) {
      return malformed();
    }
    throw error;
  }
}

function optionalCount(value: string | number | undefined): number | null {
  if (value === undefined) {
    return null;
  }
  const text = typeof value === "number" ? String(value) : value;
  if (!/^(0|[1-9][0-9]{0,15})$/.test(text)) {
    return malformed();
  }
  return Number.parseInt(text, 10);
}

function optionalEpochMillis(
  value: string | number | null | undefined,
): string | null {
  if (value === null || value === undefined) {
    return null;
  }
  const text = typeof value === "number" ? String(value) : value;
  if (!/^[1-9][0-9]{0,15}$/.test(text)) {
    return malformed();
  }
  return new Date(Number.parseInt(text, 10)).toISOString();
}

function address(value: string): string {
  try {
    return normalizeEvmAddress(value);
  } catch (error) {
    if (error instanceof InvalidChainIdentityError) {
      return malformed();
    }
    throw error;
  }
}

function normalizePairList(json: unknown): readonly TokenPairSnapshot[] {
  const parsed = responseSchema.safeParse(json);
  if (!parsed.success) {
    return malformed();
  }
  const pairs: TokenPairSnapshot[] = [];
  for (const pair of parsed.data) {
    if (pair.chainId !== dexscreenerChainSlug) {
      continue;
    }
    pairs.push(
      Object.freeze({
        pairAddress: address(pair.pairAddress),
        dexId: pair.dexId,
        labels: Object.freeze([...(pair.labels ?? [])]),
        baseTokenAddress: address(pair.baseToken.address),
        baseTokenSymbol: (pair.baseToken.symbol ?? "").slice(0, 32),
        baseTokenName:
          pair.baseToken.name === undefined ||
          pair.baseToken.name.trim().length === 0
            ? null
            : pair.baseToken.name.trim().slice(0, 128),
        quoteTokenAddress: address(pair.quoteToken.address),
        quoteTokenSymbol: (pair.quoteToken.symbol ?? "").slice(0, 32),
        priceUsd: optionalDecimal(pair.priceUsd),
        priceNative: optionalDecimal(pair.priceNative),
        liquidityUsd: optionalDecimal(pair.liquidity?.usd),
        volumeH24: optionalDecimal(pair.volume?.h24),
        priceChangeH24: optionalDecimal(pair.priceChange?.h24),
        fdv: optionalDecimal(pair.fdv),
        marketCap: optionalDecimal(pair.marketCap),
        buysH24: optionalCount(pair.txns?.h24?.buys),
        sellsH24: optionalCount(pair.txns?.h24?.sells),
        pairCreatedAt: optionalEpochMillis(pair.pairCreatedAt),
      }),
    );
  }
  return Object.freeze(pairs);
}

/**
 * The single pair the Provider returned for a pool address, or null when it
 * knows none. A pair on another chain, or under another address than the one
 * asked for, is not the requested pair and is dropped.
 */
export function normalizeDexscreenerPair(
  json: unknown,
  pairAddress: string,
): PairSnapshot {
  const parsed = pairResponseSchema.safeParse(json);
  if (!parsed.success) {
    return malformed();
  }
  const candidates = [
    ...(parsed.data.pairs ?? []),
    ...(parsed.data.pair === null || parsed.data.pair === undefined
      ? []
      : [parsed.data.pair]),
  ];
  const pairs = normalizePairList(candidates);
  const pair =
    pairs.find((candidate) => candidate.pairAddress === pairAddress) ?? null;
  return Object.freeze({ pairAddress, pair });
}

export function normalizeDexscreenerPairs(
  json: unknown,
  tokenAddress: string,
): TokenPairsSnapshot {
  return Object.freeze({ tokenAddress, pairs: normalizePairList(json) });
}

/**
 * The batch endpoint returns every pair of every requested token in one
 * list; each token's snapshot keeps the pairs in which it is base or quote.
 */
export function normalizeDexscreenerBatch(
  json: unknown,
  tokenAddresses: readonly string[],
): readonly TokenPairsSnapshot[] {
  const pairs = normalizePairList(json);
  return Object.freeze(
    tokenAddresses.map((tokenAddress) =>
      Object.freeze({
        tokenAddress,
        pairs: Object.freeze(
          pairs.filter(
            (pair) =>
              pair.baseTokenAddress === tokenAddress ||
              pair.quoteTokenAddress === tokenAddress,
          ),
        ),
      }),
    ),
  );
}

export interface CreateDexscreenerAdapterInput {
  readonly rateLimitPerMinute?: number;
  readonly fetch?: ProviderFetch;
  readonly baseUrl?: string;
  readonly now?: () => Date;
  readonly kernel?: ProviderHttpKernel;
}

export function createDexscreenerAdapter(
  input: CreateDexscreenerAdapterInput = {},
): MarketPairsProvider {
  const rateLimitPerMinute = Math.min(
    input.rateLimitPerMinute ?? dexscreenerDocumentedRateLimitPerMinute,
    dexscreenerDocumentedRateLimitPerMinute,
  );
  const kernel =
    input.kernel ??
    createProviderHttpKernel({
      fetch: input.fetch ?? nodeProviderFetch,
      rateLimiter: createRateLimiter({ capacityPerMinute: rateLimitPerMinute }),
    });
  const baseUrl = (input.baseUrl ?? dexscreenerBaseUrl).replace(/\/$/, "");
  const now = input.now ?? ((): Date => new Date());

  return Object.freeze({
    source: "dexscreener" as const,
    async readTokenPairs(
      rawTokenAddress: string,
      options: ProviderReadOptions = {},
    ): Promise<ProviderObservation<TokenPairsSnapshot>> {
      const tokenAddress = normalizeEvmAddress(rawTokenAddress);
      const result = await kernel.requestJson({
        url: `${baseUrl}/token-pairs/v1/${dexscreenerChainSlug}/${tokenAddress}`,
        ...(options.signal === undefined ? {} : { signal: options.signal }),
      });
      return Object.freeze({
        value: normalizeDexscreenerPairs(result.json, tokenAddress),
        source: "dexscreener" as const,
        fetchedAt: now().toISOString(),
        rawDigest: result.rawDigest,
      });
    },

    async readPair(
      rawPairAddress: string,
      options: ProviderReadOptions = {},
    ): Promise<ProviderObservation<PairSnapshot>> {
      const pairAddress = normalizeEvmAddress(rawPairAddress);
      const result = await kernel.requestJson({
        url: `${baseUrl}/latest/dex/pairs/${dexscreenerChainSlug}/${pairAddress}`,
        ...(options.signal === undefined ? {} : { signal: options.signal }),
      });
      return Object.freeze({
        value: normalizeDexscreenerPair(result.json, pairAddress),
        source: "dexscreener" as const,
        fetchedAt: now().toISOString(),
        rawDigest: result.rawDigest,
      });
    },

    async readTokenPairsBatch(
      rawTokenAddresses: readonly string[],
      options: ProviderReadOptions = {},
    ): Promise<ProviderObservation<readonly TokenPairsSnapshot[]>> {
      const tokenAddresses = [
        ...new Set(rawTokenAddresses.map(normalizeEvmAddress)),
      ];
      if (
        tokenAddresses.length === 0 ||
        tokenAddresses.length > marketPairsBatchLimit
      ) {
        throw new MarketProviderError(
          "market_provider_rejected",
          "MARKET_PROVIDER_REQUEST_REJECTED",
        );
      }
      const result = await kernel.requestJson({
        url: `${baseUrl}/tokens/v1/${dexscreenerChainSlug}/${tokenAddresses.join(",")}`,
        ...(options.signal === undefined ? {} : { signal: options.signal }),
      });
      return Object.freeze({
        value: normalizeDexscreenerBatch(result.json, tokenAddresses),
        source: "dexscreener" as const,
        fetchedAt: now().toISOString(),
        rawDigest: result.rawDigest,
      });
    },
  });
}
