import { encodeAbiParameters, keccak256, type Hex } from "viem";

import { launch2Template, launch2Wad } from "./launch2-contract.js";

/**
 * Decision 0124: the official Uniswap v4 pool of a graduated MEME v2
 * instance as the `/v2/launch2/*` pool routes and the `launch2_event` lane
 * see it. The PoolKey is fixed by the template (S146-contracts, Decision
 * 0006 of loop-contracts): `(min(USD1, MEME), max(USD1, MEME), 2500, 60,
 * hook)`; its `keccak256(abi.encode(key))` must equal the indexed
 * `Graduated.officialPoolId`. The `OfficialTaxHook` takes 2 % of the gross
 * output (exact-input: floor in `afterSwap`; exact-output: the requested
 * net plus `ceil(net × 200 / 9800)` in `beforeSwap`). Pure arithmetic, no
 * I/O; amounts are raw 18-decimal integers.
 */

export interface Launch2PoolKey {
  readonly currency0: string;
  readonly currency1: string;
  readonly fee: number;
  readonly tickSpacing: number;
  readonly hooks: string;
}

export type Launch2PoolSide = "buy" | "sell";
export type Launch2PoolMode = "exactIn" | "exactOut";

export const launch2PoolTaxBps = 200n;
const bpsDenominator = 10_000n;
const q192 = 2n ** 192n;

/** Above `type(int128).max` the router refuses the amount (`InvalidAmount`). */
export const launch2PoolMaxAmount = 2n ** 127n - 1n;

/**
 * The `maxAmountIn` of an exact-output quote simulation ("unbounded"): the
 * router pulls it from the (overridden) wallet balance and refunds the rest.
 */
export const launch2PoolUnboundedMaxIn = 2n ** 128n;

export const launch2PoolReasonCodes = Object.freeze({
  // 503 CAPABILITY_UNAVAILABLE.
  routerNotConfigured: "POOL_ROUTER_NOT_CONFIGURED",
  routerCodeMismatch: "POOL_ROUTER_CODE_MISMATCH",
  routerManagerMismatch: "POOL_ROUTER_MANAGER_MISMATCH",
  keyMismatch: "POOL_KEY_MISMATCH",
  // 422 VALIDATION_FAILED.
  notGraduated: "POOL_NOT_GRADUATED",
  quoteUnavailable: "POOL_QUOTE_UNAVAILABLE",
  insufficientLiquidity: "POOL_INSUFFICIENT_LIQUIDITY",
  quoteZero: "POOL_QUOTE_ZERO",
});

function lower(value: string): string {
  return value.toLowerCase();
}

/** The official PoolKey of a MEME / USD1 pair and its hook. */
export function launch2PoolKey(input: {
  readonly meme: string;
  readonly usd1: string;
  readonly hook: string;
}): Launch2PoolKey {
  const meme = lower(input.meme);
  const usd1 = lower(input.usd1);
  const memeFirst = BigInt(meme) < BigInt(usd1);
  return Object.freeze({
    currency0: memeFirst ? meme : usd1,
    currency1: memeFirst ? usd1 : meme,
    fee: launch2Template.lpFee,
    tickSpacing: launch2Template.tickSpacing,
    hooks: lower(input.hook),
  });
}

/** `PoolIdLibrary.toId`: keccak256 of the ABI-encoded key (lower-case). */
export function launch2PoolId(key: Launch2PoolKey): string {
  return lower(
    keccak256(
      encodeAbiParameters(
        [
          { type: "address" },
          { type: "address" },
          { type: "uint24" },
          { type: "int24" },
          { type: "address" },
        ],
        [
          key.currency0 as Hex,
          key.currency1 as Hex,
          key.fee,
          key.tickSpacing,
          key.hooks as Hex,
        ],
      ),
    ),
  );
}

/** Input is currency0: a buy pays USD1, a sell pays MEME. */
export function launch2PoolZeroForOne(
  key: Launch2PoolKey,
  side: Launch2PoolSide,
  meme: string,
): boolean {
  const memeIsCurrency0 = key.currency0 === lower(meme);
  return side === "buy" ? !memeIsCurrency0 : memeIsCurrency0;
}

/** USD1 per MEME (18 decimals) at a `sqrtPriceX96`; 0 for a zero price. */
export function launch2PoolPriceE18(
  sqrtPriceX96: bigint,
  memeIsCurrency0: boolean,
): bigint {
  if (sqrtPriceX96 <= 0n) return 0n;
  const squared = sqrtPriceX96 * sqrtPriceX96;
  // price(currency1 per currency0) = sqrtP² / 2^192.
  return memeIsCurrency0
    ? (squared * launch2Wad) / q192
    : (q192 * launch2Wad) / squared;
}

/** The hook's tax on a gross output (exact-input rounding, floor). */
export function launch2PoolTaxOfGross(gross: bigint): bigint {
  return (gross * launch2PoolTaxBps) / bpsDenominator;
}

/**
 * The tax behind a net output. exactOut is the hook's own formula
 * (`ceil(net × 200 / 9800)`, exact); exactIn inverts `net = gross −
 * floor(gross / 50)`: `floor(net / 49)`, which is exact except when two
 * gross amounts give the same net (then the larger tax, 1 wei off).
 */
export function launch2PoolTaxOfNet(
  net: bigint,
  mode: Launch2PoolMode,
): bigint {
  const keep = bpsDenominator - launch2PoolTaxBps;
  if (mode === "exactOut") {
    return (net * launch2PoolTaxBps + keep - 1n) / keep;
  }
  return (net * launch2PoolTaxBps) / keep;
}

/** exactIn floor: `expectedOut × (1 − slippage)`, rounded down. */
export function launch2PoolMinOut(
  expectedOut: bigint,
  slippageBps: number,
): bigint {
  return (
    (expectedOut * (bpsDenominator - BigInt(slippageBps))) / bpsDenominator
  );
}

/** exactOut ceiling: `amountIn × (1 + slippage)`, rounded up. */
export function launch2PoolMaxIn(
  amountIn: bigint,
  slippageBps: number,
): bigint {
  const factor = bpsDenominator + BigInt(slippageBps);
  return (amountIn * factor + bpsDenominator - 1n) / bpsDenominator;
}

/** USD1 per MEME of one swap (18 decimals); 0 when the MEME side is 0. */
export function launch2PoolAveragePriceE18(usd1: bigint, meme: bigint): bigint {
  return meme === 0n ? 0n : (usd1 * launch2Wad) / meme;
}

/**
 * Decision 0124: a PoolManager `Swap` log of the official pool, from the
 * swapper's side (negative = paid into the pool). Returns the USD1 / MEME
 * amounts of the trade (the output gross of the hook tax) and the tax the
 * hook took from the output at 2 % (exact-input rounding; an exact-output
 * swap may be 1 wei above). Null when the deltas are not one-in-one-out.
 */
export function launch2PoolSwapFacts(input: {
  readonly amount0: bigint;
  readonly amount1: bigint;
  readonly memeIsCurrency0: boolean;
}): {
  readonly side: Launch2PoolSide;
  readonly usd1Amount: bigint;
  readonly memeAmount: bigint;
  readonly taxAmount: bigint;
  readonly taxToken: "usd1" | "meme";
} | null {
  const meme = input.memeIsCurrency0 ? input.amount0 : input.amount1;
  const usd1 = input.memeIsCurrency0 ? input.amount1 : input.amount0;
  if (usd1 < 0n && meme > 0n) {
    return Object.freeze({
      side: "buy",
      usd1Amount: -usd1,
      memeAmount: meme,
      taxAmount: launch2PoolTaxOfGross(meme),
      taxToken: "meme",
    });
  }
  if (meme < 0n && usd1 > 0n) {
    return Object.freeze({
      side: "sell",
      usd1Amount: usd1,
      memeAmount: -meme,
      taxAmount: launch2PoolTaxOfGross(usd1),
      taxToken: "usd1",
    });
  }
  return null;
}
