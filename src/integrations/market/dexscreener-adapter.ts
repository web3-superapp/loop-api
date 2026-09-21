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

/**
 * Something this one pair carries that cannot be represented exactly
 * (Decisions 0060 and 0062):
 *
 * - a pool or token identifier that is not an EVM address — four.meme pools
 *   are `{address}:4meme`, Uniswap V4 pools are a 32-byte pool id, and
 *   Decision 0052 refuses to put either into an address field;
 * - a number the Provider sent as a *string* that is not a canonical
 *   decimal — `"3.725857251510287e+42"` as a 24 h price change, a count or
 *   a timestamp outside its documented shape.
 *
 * The pair is dropped and counted; the rest of the response stands. This is
 * not the same as a JSON *number* reaching the normaliser, which proves the
 * transport lost precision and still refuses the whole response.
 */
class UnrepresentablePairError extends Error {
  constructor(readonly field: string) {
    super("The Provider sent a pair field this adapter cannot represent");
    this.name = "UnrepresentablePairError";
  }
}

function optionalDecimal(
  field: string,
  value: string | number | null | undefined,
): string | null {
  if (value === null || value === undefined) {
    return null;
  }
  // Only lossless digit strings are accepted; a JavaScript number here would
  // mean the transport lost precision, so the whole response is refused
  // rather than used.
  if (typeof value !== "string") {
    return malformed();
  }
  try {
    return normalizeDecimalString(value);
  } catch (error) {
    if (error instanceof InvalidMarketDecimalError) {
      // The Provider's own digits, in a shape we cannot express exactly
      // (exponent notation, out of range): this pair alone is dropped.
      throw new UnrepresentablePairError(field);
    }
    throw error;
  }
}

function optionalCount(
  field: string,
  value: string | number | undefined,
): number | null {
  if (value === undefined) {
    return null;
  }
  const text = typeof value === "number" ? String(value) : value;
  if (!/^(0|[1-9][0-9]{0,15})$/.test(text)) {
    throw new UnrepresentablePairError(field);
  }
  return Number.parseInt(text, 10);
}

function optionalEpochMillis(
  field: string,
  value: string | number | null | undefined,
): string | null {
  if (value === null || value === undefined) {
    return null;
  }
  const text = typeof value === "number" ? String(value) : value;
  if (!/^[1-9][0-9]{0,15}$/.test(text)) {
    throw new UnrepresentablePairError(field);
  }
  return new Date(Number.parseInt(text, 10)).toISOString();
}

function pairIdentifier(field: string, value: string): string {
  try {
    return normalizeEvmAddress(value);
  } catch (error) {
    if (error instanceof InvalidChainIdentityError) {
      throw new UnrepresentablePairError(field);
    }
    throw error;
  }
}

type ParsedPair = z.infer<typeof pairSchema>;

/**
 * One pair. Throws `UnrepresentablePairError` when any value this pair
 * carries cannot be represented exactly — a pool or token identifier that is
 * not an address, or one of the Provider's own digit strings in a shape this
 * codebase refuses (exponent notation, out of range). That pair alone is
 * dropped. `malformed()` is left for what the response as a whole cannot be
 * trusted for: a JSON number reaching the normaliser, which proves the
 * transport lost precision.
 */
function normalizePair(pair: ParsedPair): TokenPairSnapshot {
  return Object.freeze({
    pairAddress: pairIdentifier("pairAddress", pair.pairAddress),
    dexId: pair.dexId,
    labels: Object.freeze([...(pair.labels ?? [])]),
    baseTokenAddress: pairIdentifier(
      "baseToken.address",
      pair.baseToken.address,
    ),
    baseTokenSymbol: (pair.baseToken.symbol ?? "").slice(0, 32),
    baseTokenName:
      pair.baseToken.name === undefined ||
      pair.baseToken.name.trim().length === 0
        ? null
        : pair.baseToken.name.trim().slice(0, 128),
    quoteTokenAddress: pairIdentifier(
      "quoteToken.address",
      pair.quoteToken.address,
    ),
    quoteTokenSymbol: (pair.quoteToken.symbol ?? "").slice(0, 32),
    priceUsd: optionalDecimal("priceUsd", pair.priceUsd),
    priceNative: optionalDecimal("priceNative", pair.priceNative),
    liquidityUsd: optionalDecimal("liquidity.usd", pair.liquidity?.usd),
    volumeH24: optionalDecimal("volume.h24", pair.volume?.h24),
    priceChangeH24: optionalDecimal("priceChange.h24", pair.priceChange?.h24),
    fdv: optionalDecimal("fdv", pair.fdv),
    marketCap: optionalDecimal("marketCap", pair.marketCap),
    buysH24: optionalCount("txns.h24.buys", pair.txns?.h24?.buys),
    sellsH24: optionalCount("txns.h24.sells", pair.txns?.h24?.sells),
    pairCreatedAt: optionalEpochMillis("pairCreatedAt", pair.pairCreatedAt),
  });
}

/** A pair the adapter could not represent, kept only for attribution. */
interface UnrepresentablePair {
  readonly baseTokenAddress: string;
  readonly quoteTokenAddress: string;
}

interface NormalizedPairList {
  readonly pairs: readonly TokenPairSnapshot[];
  readonly unrepresentable: readonly UnrepresentablePair[];
}

/**
 * The response shape itself must parse and every number in it must have
 * survived the transport losslessly; a single pair carrying a value this
 * adapter cannot represent is dropped and counted rather than refused
 * together with the whole list (Decisions 0060 and 0062).
 *
 * Both halves of that rule were learned from production. The list endpoint
 * mixes venues: four.meme pools are identified as `{address}:4meme` and
 * Uniswap V4 pools by a 32-byte pool id, neither of which is a pair address
 * (Decision 0052 refuses to put either into an address field) — one such
 * pool in USDT's list made the whole token unpriceable on 2026-09-21. And
 * the Provider's own numbers are not always canonical decimals: a dust
 * squadswap BTCB/WBNB pool reported `priceChange.h24` as
 * `"3.725857251510287e+42"`, which made BTCB unpriceable the same way.
 * Nothing is invented for a dropped pair: it is simply not published, and
 * the count says how many there were.
 */
function normalizePairList(json: unknown): NormalizedPairList {
  const parsed = responseSchema.safeParse(json);
  if (!parsed.success) {
    return malformed();
  }
  const pairs: TokenPairSnapshot[] = [];
  const unrepresentable: UnrepresentablePair[] = [];
  for (const pair of parsed.data) {
    if (pair.chainId !== dexscreenerChainSlug) {
      continue;
    }
    try {
      pairs.push(normalizePair(pair));
    } catch (error) {
      if (!(error instanceof UnrepresentablePairError)) {
        throw error;
      }
      unrepresentable.push(
        Object.freeze({
          baseTokenAddress: pair.baseToken.address.toLowerCase(),
          quoteTokenAddress: pair.quoteToken.address.toLowerCase(),
        }),
      );
    }
  }
  return Object.freeze({
    pairs: Object.freeze(pairs),
    unrepresentable: Object.freeze(unrepresentable),
  });
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
  const { pairs } = normalizePairList(candidates);
  const pair =
    pairs.find((candidate) => candidate.pairAddress === pairAddress) ?? null;
  // A declared pair the adapter cannot represent answers `pair: null`: the
  // caller fails closed on it rather than on the Provider as a whole.
  return Object.freeze({ pairAddress, pair });
}

export function normalizeDexscreenerPairs(
  json: unknown,
  tokenAddress: string,
): TokenPairsSnapshot {
  const { pairs, unrepresentable } = normalizePairList(json);
  return Object.freeze({
    tokenAddress,
    pairs,
    // Every pair this endpoint returns belongs to the requested token.
    unrepresentablePairCount: unrepresentable.length,
  });
}

/**
 * The batch endpoint returns every pair of every requested token in one
 * list; each token's snapshot keeps the pairs in which it is base or quote.
 */
export function normalizeDexscreenerBatch(
  json: unknown,
  tokenAddresses: readonly string[],
): readonly TokenPairsSnapshot[] {
  const { pairs, unrepresentable } = normalizePairList(json);
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
        // A dropped pair is attributed by its raw token addresses, so a
        // token is never told about a pool that is not its own.
        unrepresentablePairCount: unrepresentable.filter(
          (pair) =>
            pair.baseTokenAddress === tokenAddress ||
            pair.quoteTokenAddress === tokenAddress,
        ).length,
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
