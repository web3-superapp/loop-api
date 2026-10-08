import { bscWrappedNativeAddress } from "../market/market-contract.js";

/**
 * Pool-swap direction (Decision 0095 §3, extracted by Decision 0097 so the
 * public trades read and the community member buy feed share one rule).
 *
 * A PancakeSwap V3 `Swap` log carries pool-perspective signed amounts:
 * positive means paid into the pool, negative means paid out of it. The
 * "base" side is the token that is not a quote asset (WBNB, USDT, USDC,
 * USD1). When both or neither side is a quote asset, token0 is the base.
 * A negative base amount means the pool paid the base out, i.e. the wallet
 * received it: a buy. Anything else is a sell.
 */

/** Well-known BSC USD stablecoins (lowercase). USD1 comes from configuration. */
export const bscUsdtAddress = "0x55d398326f99059ff775485246999027b3197955";
export const bscUsdcAddress = "0x8ac76a51cc950d9822d68b83fe1ad97b32cd580d";

export interface SwapQuoteSets {
  /** Asset IDs that count as the quote side (WBNB + stables). */
  readonly quoteAssetIds: ReadonlySet<string>;
  /** Asset IDs whose amount is a USD amount (stables only). */
  readonly stableAssetIds: ReadonlySet<string>;
}

/** The quote and stable sets of one chain, as canonical asset IDs. */
export function swapQuoteSets(
  chainId: string,
  usd1Address: string | null,
): SwapQuoteSets {
  const assetId = (address: string): string =>
    `${chainId}:${address.toLowerCase()}`;
  const stables = [bscUsdtAddress, bscUsdcAddress, usd1Address].filter(
    (value): value is string => value !== null,
  );
  return Object.freeze({
    quoteAssetIds: new Set(
      [bscWrappedNativeAddress, ...stables].map((value) => assetId(value)),
    ),
    stableAssetIds: new Set(stables.map((value) => assetId(value))),
  });
}

export interface SwapLegs {
  readonly token0AssetId: string;
  readonly token1AssetId: string;
  /** Pool-perspective signed integer amounts (decimal strings or bigints). */
  readonly amount0: string | bigint;
  readonly amount1: string | bigint;
}

export interface SwapClassification {
  readonly kind: "buy" | "sell";
  readonly baseAssetId: string;
  readonly quoteAssetId: string;
  /** Signed pool-perspective amounts of each side. */
  readonly baseAmountRaw: bigint;
  readonly quoteAmountRaw: bigint;
}

export function classifySwap(
  swap: SwapLegs,
  quoteAssetIds: ReadonlySet<string>,
): SwapClassification {
  const token0Quote = quoteAssetIds.has(swap.token0AssetId);
  const token1Quote = quoteAssetIds.has(swap.token1AssetId);
  const baseIsToken0 = !(token0Quote && !token1Quote);
  const amount0 = BigInt(swap.amount0);
  const amount1 = BigInt(swap.amount1);
  const baseAmountRaw = baseIsToken0 ? amount0 : amount1;
  return Object.freeze({
    kind: baseAmountRaw < 0n ? "buy" : "sell",
    baseAssetId: baseIsToken0 ? swap.token0AssetId : swap.token1AssetId,
    quoteAssetId: baseIsToken0 ? swap.token1AssetId : swap.token0AssetId,
    baseAmountRaw,
    quoteAmountRaw: baseIsToken0 ? amount1 : amount0,
  });
}

export function absoluteAmount(value: bigint): bigint {
  return value < 0n ? -value : value;
}
