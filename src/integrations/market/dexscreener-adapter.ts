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
  type MarketPairsProvider,
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
 * One endpoint is used: `GET /token-pairs/v1/{chainId}/{tokenAddress}`,
 * documented at 300 requests per minute. The client-side throttle defaults to
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

export function normalizeDexscreenerPairs(
  json: unknown,
  tokenAddress: string,
): TokenPairsSnapshot {
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
  return Object.freeze({ tokenAddress, pairs: Object.freeze(pairs) });
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
  });
}
