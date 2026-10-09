import { memeE18, memeTotalSupply } from "./meme-curve-math.js";

/**
 * Decision 0103: the price of a graduated MEME token read from its own
 * PancakeSwap V3 pool when DexScreener has no quote (testnet 97, or a pair
 * DexScreener has not indexed yet). `slot0().sqrtPriceX96` is
 * √(token1/token0) in Q64.96; both the token and USD1 have 18 decimals, so
 * the raw ratio is the display ratio. token0 is the lower address (the V3
 * factory sorts the pair), which is how the order is known without another
 * read. USD1 is counted at par, the Launch rule.
 */

const q192 = 1n << 192n;

/** USD1 per token, 1e18-scaled, rounded down; null for a zero price. */
export function memePoolPriceE18(input: {
  readonly sqrtPriceX96: bigint;
  readonly tokenAddress: string;
  readonly usd1Address: string;
}): bigint | null {
  const squared = input.sqrtPriceX96 * input.sqrtPriceX96;
  if (squared <= 0n) {
    return null;
  }
  const tokenIsToken0 =
    BigInt(input.tokenAddress.toLowerCase()) <
    BigInt(input.usd1Address.toLowerCase());
  // token0 = token: price = token1/token0 = sqrtP² / 2^192.
  // token1 = token: price = token0/token1 = 2^192 / sqrtP².
  const priceE18 = tokenIsToken0
    ? (squared * memeE18) / q192
    : (q192 * memeE18) / squared;
  return priceE18 > 0n ? priceE18 : null;
}

/** Fully diluted cap in USD1 base units at the 1e9 supply. */
export function memePoolMarketCapRaw(priceE18: bigint): bigint {
  return (priceE18 * memeTotalSupply) / memeE18;
}

export interface MemePoolPrice {
  readonly priceE18: bigint;
  readonly observedAt: string;
}

/**
 * Reads one pool's price, or null when the read fails (the caller keeps
 * its unavailable reason). Successful reads are reused for `cacheMs`, the
 * 1.5 s cache of the detail's other chain reads; failures are not cached.
 */
export type MemePoolPriceReader = (input: {
  readonly tokenAddress: string;
  readonly poolAddress: string;
}) => Promise<MemePoolPrice | null>;

/** Decision 0105: the map key of one pool/token pair (lower-case). */
export function memePoolPriceKey(input: {
  readonly tokenAddress: string;
  readonly poolAddress: string;
}): string {
  return `${input.poolAddress.toLowerCase()}:${input.tokenAddress.toLowerCase()}`;
}

/**
 * Decision 0105: many pools in one batch (one multicall). The map holds a
 * price, or null when that pool's read failed, under `memePoolPriceKey`.
 */
export type MemePoolPriceBatchReader = (
  inputs: readonly {
    readonly tokenAddress: string;
    readonly poolAddress: string;
  }[],
) => Promise<ReadonlyMap<string, MemePoolPrice | null>>;

export interface MemePoolPriceReaders {
  readonly read: MemePoolPriceReader;
  readonly readMany: MemePoolPriceBatchReader;
}

/**
 * The single reader plus a batched one sharing its cache. Without
 * `readSqrtPriceX96Many` the batch is the single reads run together.
 */
export function createMemePoolPriceReaders(options: {
  readonly usd1Address: () => string | null;
  readonly readSqrtPriceX96: (pool: string) => Promise<bigint>;
  /** One multicall: the price of each pool, absent when its call failed. */
  readonly readSqrtPriceX96Many?: (
    pools: readonly string[],
  ) => Promise<ReadonlyMap<string, bigint>>;
  readonly cacheMs: number;
  readonly now?: () => Date;
}): MemePoolPriceReaders {
  const now = options.now ?? ((): Date => new Date());
  const cache = new Map<
    string,
    { readonly expiresAt: number; readonly price: MemePoolPrice }
  >();
  const single = createMemePoolPriceReader(options);
  const readMany: MemePoolPriceBatchReader = async (inputs) => {
    const result = new Map<string, MemePoolPrice | null>();
    const usd1Address = options.usd1Address();
    if (usd1Address === null) {
      for (const input of inputs) {
        result.set(memePoolPriceKey(input), null);
      }
      return result;
    }
    const at = now().getTime();
    for (const [key, entry] of cache) {
      if (entry.expiresAt <= at) {
        cache.delete(key);
      }
    }
    const missing = new Map<string, { token: string; pool: string }>();
    for (const input of inputs) {
      const key = memePoolPriceKey(input);
      const hit = cache.get(key);
      if (hit !== undefined) {
        result.set(key, hit.price);
      } else {
        missing.set(key, {
          token: input.tokenAddress.toLowerCase(),
          pool: input.poolAddress.toLowerCase(),
        });
      }
    }
    if (missing.size === 0) {
      return result;
    }
    if (options.readSqrtPriceX96Many === undefined) {
      await Promise.all(
        [...missing].map(async ([key, pair]) => {
          result.set(
            key,
            await single({ tokenAddress: pair.token, poolAddress: pair.pool }),
          );
        }),
      );
      return result;
    }
    let roots: ReadonlyMap<string, bigint>;
    try {
      roots = await options.readSqrtPriceX96Many([
        ...new Set([...missing.values()].map((pair) => pair.pool)),
      ]);
    } catch {
      roots = new Map();
    }
    for (const [key, pair] of missing) {
      const sqrtPriceX96 = roots.get(pair.pool);
      const priceE18 =
        sqrtPriceX96 === undefined
          ? null
          : memePoolPriceE18({
              sqrtPriceX96,
              tokenAddress: pair.token,
              usd1Address,
            });
      if (priceE18 === null) {
        result.set(key, null);
        continue;
      }
      const price = Object.freeze({
        priceE18,
        observedAt: new Date(at).toISOString(),
      });
      cache.set(key, { expiresAt: at + options.cacheMs, price });
      result.set(key, price);
    }
    return result;
  };
  return Object.freeze({ read: single, readMany });
}

export function createMemePoolPriceReader(options: {
  readonly usd1Address: () => string | null;
  readonly readSqrtPriceX96: (pool: string) => Promise<bigint>;
  readonly cacheMs: number;
  readonly now?: () => Date;
}): MemePoolPriceReader {
  const now = options.now ?? ((): Date => new Date());
  const cache = new Map<
    string,
    { readonly expiresAt: number; readonly promise: Promise<MemePoolPrice> }
  >();
  return async (input) => {
    const usd1Address = options.usd1Address();
    if (usd1Address === null) {
      return null;
    }
    const pool = input.poolAddress.toLowerCase();
    const token = input.tokenAddress.toLowerCase();
    const key = `${pool}:${token}`;
    const at = now().getTime();
    for (const [staleKey, entry] of cache) {
      if (entry.expiresAt <= at) {
        cache.delete(staleKey);
      }
    }
    let entry = cache.get(key);
    if (entry === undefined) {
      const promise = options.readSqrtPriceX96(pool).then((sqrtPriceX96) => {
        const priceE18 = memePoolPriceE18({
          sqrtPriceX96,
          tokenAddress: token,
          usd1Address,
        });
        if (priceE18 === null) {
          throw new RangeError("pool price is zero");
        }
        return Object.freeze({
          priceE18,
          observedAt: new Date(at).toISOString(),
        });
      });
      entry = { expiresAt: at + options.cacheMs, promise };
      cache.set(key, entry);
      promise.catch(() => {
        cache.delete(key);
      });
    }
    try {
      return await entry.promise;
    } catch {
      return null;
    }
  };
}
