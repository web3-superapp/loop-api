/**
 * LoopMemeCurve math, recomputed off-chain (Decision 0101, docs/10 §2).
 *
 * A line-for-line port of loop-contracts `scripts/lib/meme-math.ts`
 * (loop-contracts Decision 0001 §2), which mirrors the Solidity integer
 * rounding exactly: the contract stores only `vUsd1` / `vToken`, keeps
 * `vUsd1 == ceil(k / vToken)` after every trade, and derives
 * `realUsd1 = vUsd1 − V0` and `sold = T0 − vToken`. Every value is a bigint
 * in 18-decimal base units; nothing here ever touches a JavaScript number.
 */

export const memeBps = 10_000n;
export const memeE18 = 10n ** 18n;
export const memeV0 = 6_000n * memeE18;
export const memeT0 = 1_073_000_000n * memeE18;
export const memeK = memeV0 * memeT0;
export const memeTotalSupply = 1_000_000_000n * memeE18;
export const memeSaleSupply = 800_000_000n * memeE18;
export const memePoolSupply = 200_000_000n * memeE18;
export const memeVTokenFull = memeT0 - memeSaleSupply;
export const memeTradeFeeBps = 100n;
export const memeGraduationFeeUsd1 = 600n * memeE18;
export const memeWalletCapBps = 500n;
export const memeWalletCap = (memeSaleSupply * memeWalletCapBps) / memeBps;
export const memeMinBuyUsd1 = memeE18;
export const memePoolFee = 2500;

/** The `params()` tuple the adapter compares against these constants. */
export const memeCurveParameters = Object.freeze({
  v0: memeV0,
  t0: memeT0,
  saleSupply: memeSaleSupply,
  poolSupply: memePoolSupply,
  tradeFeeBps: memeTradeFeeBps,
  graduationFeeUsd1: memeGraduationFeeUsd1,
  walletCapBps: memeWalletCapBps,
  minBuyUsd1: memeMinBuyUsd1,
  poolFee: memePoolFee,
});

export function ceilDiv(a: bigint, b: bigint): bigint {
  return a === 0n ? 0n : (a - 1n) / b + 1n;
}

export interface MemeCurveState {
  readonly vUsd1: bigint;
  readonly vToken: bigint;
}

export const freshMemeCurve: MemeCurveState = Object.freeze({
  vUsd1: memeV0,
  vToken: memeT0,
});

export function realUsd1Of(curve: MemeCurveState): bigint {
  return curve.vUsd1 - memeV0;
}

export function soldOf(curve: MemeCurveState): bigint {
  return memeT0 - curve.vToken;
}

export interface MemeBuyQuote {
  readonly tokensOut: bigint;
  readonly fee: bigint;
  readonly refund: bigint;
  /** What the wallet actually pays: `usd1In − refund` (fee included). */
  readonly paid: bigint;
  readonly newVUsd1: bigint;
  readonly newVToken: bigint;
}

/** docs/10 §2 buy, with the loop-contracts 0001 §2.3 "fill" branch. */
export function quoteMemeBuy(
  curve: MemeCurveState,
  usd1In: bigint,
): MemeBuyQuote {
  if (usd1In < 0n) {
    throw new RangeError("usd1In must not be negative");
  }
  let fee = ceilDiv(usd1In * memeTradeFeeBps, memeBps);
  let net = usd1In - fee;
  let newVUsd1 = curve.vUsd1 + net;
  let newVToken = ceilDiv(memeK, newVUsd1);
  let refund = 0n;
  if (newVToken < memeVTokenFull) {
    newVToken = memeVTokenFull;
    newVUsd1 = ceilDiv(memeK, memeVTokenFull);
    net = newVUsd1 - curve.vUsd1;
    fee = ceilDiv(net * memeTradeFeeBps, memeBps - memeTradeFeeBps);
    if (net + fee > usd1In) {
      fee = usd1In - net;
    }
    refund = usd1In - net - fee;
  }
  return Object.freeze({
    tokensOut: curve.vToken - newVToken,
    fee,
    refund,
    paid: usd1In - refund,
    newVUsd1,
    newVToken,
  });
}

export interface MemeSellQuote {
  readonly usd1Out: bigint;
  readonly fee: bigint;
  readonly gross: bigint;
  readonly newVUsd1: bigint;
  readonly newVToken: bigint;
}

export class MemeSellExceedsSoldError extends RangeError {
  constructor() {
    super("sell exceeds the sold supply");
    this.name = "MemeSellExceedsSoldError";
  }
}

/** docs/10 §2 sell (loop-contracts 0001 §2.4). */
export function quoteMemeSell(
  curve: MemeCurveState,
  tokensIn: bigint,
): MemeSellQuote {
  if (tokensIn < 0n) {
    throw new RangeError("tokensIn must not be negative");
  }
  const newVToken = curve.vToken + tokensIn;
  if (newVToken > memeT0) {
    throw new MemeSellExceedsSoldError();
  }
  const newVUsd1 = ceilDiv(memeK, newVToken);
  const gross = curve.vUsd1 - newVUsd1;
  const fee = ceilDiv(gross * memeTradeFeeBps, memeBps);
  return Object.freeze({
    usd1Out: gross - fee,
    fee,
    gross,
    newVUsd1,
    newVToken,
  });
}

/** Spot price, 1e18 fixed point (USD1 per whole token), rounded down. */
export function memePriceE18(curve: MemeCurveState): bigint {
  return (curve.vUsd1 * memeE18) / curve.vToken;
}

/** Fully diluted cap in USD1 base units: price × 1e9 tokens, rounded down. */
export function memeMarketCapRaw(curve: MemeCurveState): bigint {
  return (curve.vUsd1 * memeTotalSupply) / curve.vToken;
}

/** `sold / SALE_SUPPLY` in basis points, rounded down (0–10000). */
export function memeProgressBps(sold: bigint): number {
  if (sold <= 0n) {
    return 0;
  }
  const bps = (sold * memeBps) / memeSaleSupply;
  return Number(bps > memeBps ? memeBps : bps);
}

/**
 * Price impact of a trade in basis points: how far the post-trade spot
 * price moved from the pre-trade spot price, rounded down.
 */
export function memePriceImpactBps(
  before: MemeCurveState,
  after: MemeCurveState,
): number {
  const p0 = memePriceE18(before);
  const p1 = memePriceE18(after);
  if (p0 === 0n) {
    return 0;
  }
  const delta = p1 > p0 ? p1 - p0 : p0 - p1;
  const bps = (delta * memeBps) / p0;
  return Number(bps > 1_000_000n ? 1_000_000n : bps);
}

/** USD1 that reaches the pool on graduation: realUsd1 at full − 600 fee. */
export const memeGraduationUsd1Estimate =
  ceilDiv(memeK, memeVTokenFull) - memeV0 - memeGraduationFeeUsd1;

/**
 * Formats an 18-decimal fixed-point bigint as a plain decimal string with
 * trailing zeros trimmed (`"0.0000055918…"`, `"17582.4175…"`).
 */
export function formatE18(value: bigint): string {
  const negative = value < 0n;
  const absolute = negative ? -value : value;
  const whole = absolute / memeE18;
  const fraction = (absolute % memeE18)
    .toString(10)
    .padStart(18, "0")
    .replace(/0+$/u, "");
  return `${negative ? "-" : ""}${whole.toString(10)}${fraction === "" ? "" : `.${fraction}`}`;
}

/**
 * Relative difference |a − b| / max(a, b) exceeds `thresholdBps`
 * (Decision 0101: recomputation vs. the chain's `quoteBuy` / `quoteSell`;
 * > 0.1% = 10 bps is logged as a warning).
 */
export function exceedsRelativeDifference(
  a: bigint,
  b: bigint,
  thresholdBps: bigint,
): boolean {
  if (a === b) {
    return false;
  }
  const larger = a > b ? a : b;
  const delta = a > b ? a - b : b - a;
  return delta * memeBps > larger * thresholdBps;
}
