import { launch2Template, launch2Wad } from "./launch2-contract.js";

/**
 * Decision 0114: a BigInt port of `CurveMath` and the buy/sell quote paths
 * of `CurveEngine` (loop-contracts `protocol/`, Decision 0002). Every
 * rounding follows the Solidity source (`Math.mulDiv` floors, the tax is
 * `floor(amount × 1000 / 10000)`, the gross for a net reserve starts at
 * `ceil(net × 10000 / 9000)` and steps up until its post-tax part covers it), so a quote here equals
 * the contract's `quoteMaxBuy` / `quoteBuy` / `quoteSell` at the same state;
 * the anvil suite compares them.
 */

const sale = launch2Template.curveSaleSupply;
const graduationReserve = launch2Template.graduationReserve;
const virtualUsd1 = graduationReserve / 3n;
const virtualMeme = (sale * 4n) / 3n;
const taxBps = launch2Template.curveBuyTaxBps;
const sellTaxBps = launch2Template.curveSellTaxBps;
const denominator = launch2Template.taxDenominator;
const cap = launch2Template.perAddressCap;

export class Launch2CurveRangeError extends RangeError {
  constructor(message: string) {
    super(message);
    this.name = "Launch2CurveRangeError";
  }
}

function ceilDiv(numerator: bigint, divisor: bigint): bigint {
  return (numerator + divisor - 1n) / divisor;
}

/** R(s) = Qv·s / (Tv − s), floored. */
export function launch2ReserveAt(sold: bigint): bigint {
  if (sold < 0n || sold > sale) {
    throw new Launch2CurveRangeError("sold supply out of range");
  }
  return (virtualUsd1 * sold) / (virtualMeme - sold);
}

/** p(s) = Qv·Tv / (Tv − s)², USD1 per whole MEME, WAD-scaled, floored. */
export function launch2PriceAt(sold: bigint): bigint {
  if (sold < 0n || sold > sale) {
    throw new Launch2CurveRangeError("sold supply out of range");
  }
  const remaining = virtualMeme - sold;
  return (virtualUsd1 * virtualMeme * launch2Wad) / (remaining * remaining);
}

export function launch2FloorBps(amount: bigint, bps: bigint): bigint {
  return (amount * bps) / denominator;
}

/** `CurveMath.quoteBuy`: net USD1 available to the curve → next sold supply. */
export function launch2CurveQuoteBuy(
  sold: bigint,
  netUsd1In: bigint,
): { readonly nextSold: bigint; readonly reserveUsed: bigint } {
  const currentReserve = launch2ReserveAt(sold);
  const remainingReserve = graduationReserve - currentReserve;
  let nextSold: bigint;
  if (netUsd1In >= remainingReserve) {
    nextSold = sale;
  } else if (netUsd1In === 0n) {
    nextSold = sold;
  } else {
    const target = currentReserve + netUsd1In;
    nextSold = (target * virtualMeme) / (virtualUsd1 + target);
  }
  return {
    nextSold,
    reserveUsed: launch2ReserveAt(nextSold) - currentReserve,
  };
}

/** `CurveEngine._grossForNet`: ceil(net / 0.9), stepped until the post-tax part covers `net`. */
export function launch2GrossForNet(net: bigint): bigint {
  if (net === 0n) return 0n;
  let gross = ceilDiv(net * denominator, denominator - taxBps);
  while (gross - launch2FloorBps(gross, taxBps) < net) {
    gross += 1n;
  }
  return gross;
}

/** The curve facts every quote reads at one block. */
export interface Launch2CurveState {
  readonly published: boolean;
  readonly graduated: boolean;
  /** Unix seconds; 0 while the snapshot root is not published. */
  readonly earlyRoundEndsAt: bigint;
  readonly soldSupply: bigint;
  readonly accountedReserve: bigint;
  /** Unix seconds of the block the state was read at. */
  readonly blockTimestamp: bigint;
}

export type Launch2MaxLimit =
  "quota" | "inventory" | "balance" | "sold_supply" | "closed";

export interface Launch2MaxBuy {
  readonly maxUsd1In: bigint;
  readonly maxMemeOut: bigint;
  readonly limitedBy: Launch2MaxLimit;
  readonly quotaRemaining: bigint;
  readonly inventoryRemaining: bigint;
}

/** `CurveEngine.quoteMaxBuy` plus which bound decided it. */
export function launch2QuoteMaxBuy(
  state: Launch2CurveState,
  cumulativeBought: bigint,
): Launch2MaxBuy {
  const quotaRemaining = cumulativeBought >= cap ? 0n : cap - cumulativeBought;
  const inventoryRemaining = sale - state.soldSupply;
  const closed = {
    maxUsd1In: 0n,
    maxMemeOut: 0n,
    quotaRemaining,
    inventoryRemaining,
  };
  if (!state.published || state.graduated || state.earlyRoundEndsAt === 0n) {
    return { ...closed, limitedBy: "closed" };
  }
  const limitedBy: Launch2MaxLimit =
    quotaRemaining <= inventoryRemaining ? "quota" : "inventory";
  const maxMemeOut =
    quotaRemaining < inventoryRemaining ? quotaRemaining : inventoryRemaining;
  if (maxMemeOut === 0n) {
    return { ...closed, limitedBy };
  }
  const current = launch2ReserveAt(state.soldSupply);
  const target = launch2ReserveAt(state.soldSupply + maxMemeOut);
  return {
    maxUsd1In: launch2GrossForNet(target - current),
    maxMemeOut,
    limitedBy,
    quotaRemaining,
    inventoryRemaining,
  };
}

export interface Launch2BuyQuote {
  readonly memeOut: bigint;
  readonly usd1Accepted: bigint;
  readonly platformTax: bigint;
  readonly usd1Refund: bigint;
  readonly nextSoldSupply: bigint;
  readonly reserveIn: bigint;
}

/** `CurveEngine._quoteBuy` for `amountInMax` USD1 (tax included). */
export function launch2QuoteBuy(
  state: Launch2CurveState,
  cumulativeBought: bigint,
  amountInMax: bigint,
): Launch2BuyQuote {
  const zero: Launch2BuyQuote = {
    memeOut: 0n,
    usd1Accepted: 0n,
    platformTax: 0n,
    usd1Refund: amountInMax,
    nextSoldSupply: state.soldSupply,
    reserveIn: 0n,
  };
  const max = launch2QuoteMaxBuy(state, cumulativeBought);
  if (max.maxUsd1In === 0n || amountInMax === 0n) return zero;
  const cappedGross = amountInMax < max.maxUsd1In ? amountInMax : max.maxUsd1In;
  const maxSold = state.soldSupply + max.maxMemeOut;
  let nextSold: bigint;
  if (amountInMax >= max.maxUsd1In) {
    nextSold = maxSold;
  } else {
    const budgetNet = cappedGross - launch2FloorBps(cappedGross, taxBps);
    nextSold = launch2CurveQuoteBuy(state.soldSupply, budgetNet).nextSold;
    if (nextSold > maxSold) nextSold = maxSold;
  }
  const memeOut = nextSold - state.soldSupply;
  const reserveIn = launch2ReserveAt(nextSold) - state.accountedReserve;
  if (memeOut === 0n || reserveIn <= 0n) return zero;
  const gross = launch2GrossForNet(reserveIn);
  const platformTax = launch2FloorBps(gross, taxBps);
  const curveNet = gross - platformTax;
  const usd1Refund = amountInMax - gross + (curveNet - reserveIn);
  return {
    memeOut,
    usd1Accepted: amountInMax - usd1Refund,
    platformTax,
    usd1Refund,
    nextSoldSupply: nextSold,
    reserveIn,
  };
}

export interface Launch2SellQuote {
  readonly usd1Out: bigint;
  readonly platformTax: bigint;
  readonly nextSoldSupply: bigint;
}

/** `CurveEngine.quoteSell`; throws when `memeIn` exceeds the sold supply. */
export function launch2QuoteSell(
  soldSupply: bigint,
  memeIn: bigint,
): Launch2SellQuote {
  if (memeIn > soldSupply) {
    throw new Launch2CurveRangeError("sell exceeds the sold supply");
  }
  const nextSold = soldSupply - memeIn;
  const gross = launch2ReserveAt(soldSupply) - launch2ReserveAt(nextSold);
  const platformTax = launch2FloorBps(gross, sellTaxBps);
  return {
    usd1Out: gross - platformTax,
    platformTax,
    nextSoldSupply: nextSold,
  };
}

export interface Launch2Max {
  readonly side: "buy" | "sell";
  /** Buy: USD1 in (tax included). Sell: MEME in. */
  readonly amountIn: bigint;
  /** Buy: MEME out. Sell: USD1 out (after tax). */
  readonly amountOut: bigint;
  readonly limitedBy: Launch2MaxLimit;
}

/**
 * The executable MAX (整体方案 §3): buy = the contract's `quoteMaxBuy`
 * (remaining 0.5 % quota vs remaining inventory, priced on the curve with
 * the 10 % tax), lowered to the wallet's USD1 balance when that is smaller;
 * sell = the wallet's MEME balance, bounded by the sold supply.
 */
export function launch2Max(input: {
  readonly side: "buy" | "sell";
  readonly state: Launch2CurveState;
  readonly cumulativeBought: bigint;
  readonly balance: bigint | null;
}): Launch2Max {
  const { state } = input;
  if (input.side === "buy") {
    const max = launch2QuoteMaxBuy(state, input.cumulativeBought);
    if (
      max.maxUsd1In > 0n &&
      input.balance !== null &&
      input.balance < max.maxUsd1In
    ) {
      const quote = launch2QuoteBuy(
        state,
        input.cumulativeBought,
        input.balance,
      );
      return {
        side: "buy",
        amountIn: quote.memeOut === 0n ? 0n : input.balance,
        amountOut: quote.memeOut,
        limitedBy: "balance",
      };
    }
    return {
      side: "buy",
      amountIn: max.maxUsd1In,
      amountOut: max.maxMemeOut,
      limitedBy: max.limitedBy,
    };
  }
  if (
    !state.published ||
    state.graduated ||
    state.earlyRoundEndsAt === 0n ||
    state.blockTimestamp < state.earlyRoundEndsAt
  ) {
    // CurveEngine.sell opens only after the priority hour.
    return { side: "sell", amountIn: 0n, amountOut: 0n, limitedBy: "closed" };
  }
  const balance = input.balance ?? state.soldSupply;
  const byBalance = input.balance !== null && balance < state.soldSupply;
  const amountIn = byBalance ? balance : state.soldSupply;
  return {
    side: "sell",
    amountIn,
    amountOut:
      amountIn === 0n
        ? 0n
        : launch2QuoteSell(state.soldSupply, amountIn).usd1Out,
    limitedBy: byBalance ? "balance" : "sold_supply",
  };
}
