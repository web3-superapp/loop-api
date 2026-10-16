import { encodeFunctionData, type Hex } from "viem";

import {
  loopDynamicHookAbi,
  loopRouterAbi,
} from "../../integrations/launch/hooks-launch-protocol-abi.generated.js";
import type { Launch2PoolKey } from "./launch2-pool.js";

/**
 * Decision 0131 (S166): the optional LoopDynamic official-pool Hook kind
 * (loop-contracts S164 + S165, Decision 0009). Pure arithmetic and
 * vocabulary, no I/O:
 *
 * - the instance's hook kind is a registry fact: a LoopDynamic Factory
 *   deploys no Hook at `deployLaunch` (`LaunchDeployed.hook = 0`); the
 *   per-project `LoopDynamicHook` is deployed and bound in the graduation
 *   transaction (`LoopHookBound`);
 * - a TypeScript port of the Hook's `PriceMath` and of `_rollCandle`, so a
 *   quote knows whether the swap that rolls the 5-minute candle will find a
 *   round armed (and so whether a buy earns reward weight);
 * - the fee split of a quote (S165: buy fee 2 % of the MEME output; sell
 *   base 2 % of the USD1 output plus the dynamic fee on top);
 * - the contract error → reason code map (with the App's Chinese copy).
 *
 * Amounts are raw 18-decimal integers (`bigint`), never JS numbers.
 */

export const launch2PoolHookKinds = Object.freeze([
  "officialTax",
  "loopDynamic",
] as const);
export type Launch2PoolHookKind = (typeof launch2PoolHookKinds)[number];

export const launch2ZeroAddress = "0x0000000000000000000000000000000000000000";

/** The registry row's hook: zero = LoopDynamic (Hook deployed at graduation). */
export function launch2HookKindOf(hookAddress: string): Launch2PoolHookKind {
  return hookAddress.toLowerCase() === launch2ZeroAddress
    ? "loopDynamic"
    : "officialTax";
}

export const launch2DynamicWad = 10n ** 18n;
const ppmDenominator = 1_000_000n;
const q128 = 1n << 128n;
/** `LoopAccounting.CANDLE_SECONDS`. */
export const launch2DynamicCandleSeconds = 300n;
/** v4 `TickMath.MIN_SQRT_PRICE + 1` / `MAX_SQRT_PRICE - 1` (LoopRouter limits). */
export const launch2MinSqrtPriceLimit = 4295128739n + 1n;
export const launch2MaxSqrtPriceLimit =
  1461446703485210103287273052203988822378723970342n - 1n;

export const launch2DynamicReasonCodes = Object.freeze({
  // 503 CAPABILITY_UNAVAILABLE.
  routerNotConfigured: "LAUNCH2_DYNAMIC_ROUTER_NOT_CONFIGURED",
  routerCodeMismatch: "LAUNCH2_DYNAMIC_ROUTER_CODE_MISMATCH",
  routerManagerMismatch: "LAUNCH2_DYNAMIC_ROUTER_MANAGER_MISMATCH",
  hookNotIndexed: "LAUNCH2_DYNAMIC_HOOK_NOT_INDEXED",
  hookMismatch: "LAUNCH2_DYNAMIC_HOOK_MISMATCH",
  hookNotInitialized: "LAUNCH2_DYNAMIC_HOOK_NOT_INITIALIZED",
  // Decision 0153: the instance's Factory is not a trusted LoopDynamic
  // Factory (not LAUNCH2_DYNAMIC_FACTORY_ADDRESS / a v3 legacy entry, or
  // it has no LoopDynamic routing getters).
  factoryUnknown: "LAUNCH2_DYNAMIC_FACTORY_UNKNOWN",
  // Decision 0153: the current Factory's loopRouter() / routerRegistry()
  // differ from LAUNCH2_DYNAMIC_ROUTER_ADDRESS / _REGISTRY_ADDRESS.
  routerMismatch: "LAUNCH2_DYNAMIC_ROUTER_MISMATCH",
  // 422 VALIDATION_FAILED.
  exactOutUnsupported: "LAUNCH2_EXACT_OUT_UNSUPPORTED",
  notApplicable: "LAUNCH2_DYNAMIC_POOL_NOT_APPLICABLE",
  roundInvalid: "LAUNCH2_DYNAMIC_ROUND_INVALID",
  routerUnauthorized: "LAUNCH2_DYNAMIC_ROUTER_UNAUTHORIZED",
  swapUnsupported: "LAUNCH2_DYNAMIC_SWAP_UNSUPPORTED",
  // 409 DATA_STALE.
  hookBusy: "LAUNCH2_DYNAMIC_HOOK_BUSY",
  roundNotClosed: "LAUNCH2_DYNAMIC_ROUND_NOT_CLOSED",
  // 409 RESOURCE_CONFLICT.
  alreadyClaimed: "LAUNCH2_DYNAMIC_ALREADY_CLAIMED",
  claimTransactionConflict: "LAUNCH2_DYNAMIC_CLAIM_TRANSACTION_CONFLICT",
  // 409 INSUFFICIENT_BALANCE.
  nothingToClaim: "LAUNCH2_DYNAMIC_NOTHING_TO_CLAIM",
  // 404 NOT_FOUND.
  claimIntentNotFound: "LAUNCH2_DYNAMIC_CLAIM_INTENT_NOT_FOUND",
} as const);

/**
 * The App's copy for every LoopDynamic reason code (zh-CN). The server
 * never sends prose; the client maps `detailsSafe.reasonCode` to this.
 */
export const launch2DynamicReasonMessagesZh: Readonly<
  Record<
    (typeof launch2DynamicReasonCodes)[keyof typeof launch2DynamicReasonCodes],
    string
  >
> = Object.freeze({
  LAUNCH2_DYNAMIC_ROUTER_NOT_CONFIGURED: "外盘路由未配置，暂不可交易",
  LAUNCH2_DYNAMIC_ROUTER_CODE_MISMATCH: "外盘路由校验未通过，暂不可交易",
  LAUNCH2_DYNAMIC_ROUTER_MANAGER_MISMATCH: "外盘路由与池子不匹配，暂不可交易",
  LAUNCH2_DYNAMIC_HOOK_NOT_INDEXED: "外盘池子正在同步，请稍后再试",
  LAUNCH2_DYNAMIC_HOOK_MISMATCH: "外盘池子校验未通过，暂不可交易",
  LAUNCH2_DYNAMIC_HOOK_NOT_INITIALIZED: "外盘池子尚未初始化",
  LAUNCH2_DYNAMIC_FACTORY_UNKNOWN: "外盘池子来源未登记，暂不可交易",
  LAUNCH2_DYNAMIC_ROUTER_MISMATCH: "外盘路由配置不一致，暂不可交易",
  LAUNCH2_EXACT_OUT_UNSUPPORTED: "该池子只支持按支付金额交易",
  LAUNCH2_DYNAMIC_POOL_NOT_APPLICABLE: "该项目的外盘没有奖励轮次",
  LAUNCH2_DYNAMIC_ROUND_INVALID: "轮次编号无效",
  LAUNCH2_DYNAMIC_ROUTER_UNAUTHORIZED: "池子拒绝了这个交易入口",
  LAUNCH2_DYNAMIC_SWAP_UNSUPPORTED: "池子不支持这种交易方式",
  LAUNCH2_DYNAMIC_HOOK_BUSY: "池子正忙，请稍后重试",
  LAUNCH2_DYNAMIC_ROUND_NOT_CLOSED: "本轮还没有结束，结束后才能领取",
  LAUNCH2_DYNAMIC_ALREADY_CLAIMED: "本轮奖励已经领取过",
  LAUNCH2_DYNAMIC_CLAIM_TRANSACTION_CONFLICT: "这次领取已经记录了另一笔交易",
  LAUNCH2_DYNAMIC_NOTHING_TO_CLAIM: "本轮没有可领取的奖励",
  LAUNCH2_DYNAMIC_CLAIM_INTENT_NOT_FOUND: "找不到这次领取请求",
});

export type Launch2DynamicRevertCode =
  | "VALIDATION_FAILED"
  | "DATA_STALE"
  | "RESOURCE_CONFLICT"
  | "QUOTE_EXPIRED"
  | "CAPABILITY_UNAVAILABLE";

/**
 * A decoded LoopRouter / LoopDynamicHook / PoolManager error → the v2 error
 * code and reason code a quote, prepare, or claim answers with. Unknown
 * names stay `null` (the caller answers its generic "simulation reverted").
 */
export function classifyLaunch2DynamicRevert(errorName: string | null): {
  readonly code: Launch2DynamicRevertCode;
  readonly reasonCode: string;
} | null {
  const r = launch2DynamicReasonCodes;
  switch (errorName) {
    case "UnauthorizedRouter":
      return { code: "VALIDATION_FAILED", reasonCode: r.routerUnauthorized };
    case "UnsupportedSwap":
      return { code: "VALIDATION_FAILED", reasonCode: r.swapUnsupported };
    case "Busy":
      return { code: "DATA_STALE", reasonCode: r.hookBusy };
    case "RoundNotClosed":
      return { code: "DATA_STALE", reasonCode: r.roundNotClosed };
    case "AlreadyClaimed":
      return { code: "RESOURCE_CONFLICT", reasonCode: r.alreadyClaimed };
    case "NotInitialized":
      return {
        code: "CAPABILITY_UNAVAILABLE",
        reasonCode: r.hookNotInitialized,
      };
    case "UnsupportedPool":
      return { code: "CAPABILITY_UNAVAILABLE", reasonCode: r.hookMismatch };
    case "DeadlineExpired":
      return { code: "QUOTE_EXPIRED", reasonCode: "LAUNCH2_QUOTE_EXPIRED" };
    case "InvalidAmount":
      return {
        code: "VALIDATION_FAILED",
        reasonCode: "LAUNCH2_AMOUNT_INVALID",
      };
    case "InvalidDelta":
      return { code: "VALIDATION_FAILED", reasonCode: "POOL_QUOTE_ZERO" };
    case "Slippage":
      return { code: "DATA_STALE", reasonCode: "LAUNCH2_PRICE_MOVED" };
    default:
      return null;
  }
}

// ---------------------------------------------------------------------------
// FullMath / PriceMath (exact bigint ports)
// ---------------------------------------------------------------------------

function mulDiv(a: bigint, b: bigint, d: bigint): bigint {
  return (a * b) / d;
}

function mulDivRoundingUp(a: bigint, b: bigint, d: bigint): bigint {
  const product = a * b;
  return product / d + (product % d === 0n ? 0n : 1n);
}

/** `PriceMath.isGreen`: MEME went up over the candle. */
export function launch2DynamicIsGreen(
  open: bigint,
  close: bigint,
  memeIsCurrency0: boolean,
): boolean {
  return memeIsCurrency0 ? close > open : close < open;
}

/** MEME went down over the candle (strictly; a flat candle is not red). */
export function launch2DynamicIsRed(
  open: bigint,
  close: bigint,
  memeIsCurrency0: boolean,
): boolean {
  return memeIsCurrency0 ? close < open : close > open;
}

/**
 * Decision 0144 (S193, docs/36 Q10 ruling 2026-10-15): when an armed
 * round closes at a candle roll.
 *
 * - `closeAtOrAboveOpen` (S193 Hooks, the ruled rule): the first candle
 *   that no longer falls closes the round — `close ≥ open`, a flat
 *   (doji) candle included;
 * - `closeAboveOpen` (pre-S193 Hooks, the loop_hook_v1 prototype): only a
 *   green candle (`close > open`) closes it; a flat candle keeps it armed.
 *
 * A Hook's rule is a chain fact: a Hook that answers `maxDynamicFeeWad()`
 * (S193 generation, loop-contracts Decision 0012) closes on flat; one
 * without the getter (S165, legacy Factory instances) does not.
 */
export const launch2DynamicRoundCloseRules = Object.freeze([
  "closeAtOrAboveOpen",
  "closeAboveOpen",
] as const);
export type Launch2DynamicRoundCloseRule =
  (typeof launch2DynamicRoundCloseRules)[number];

/** Whether the candle `open → close` closes an armed round under `rule`. */
export function launch2DynamicClosesRound(
  open: bigint,
  close: bigint,
  memeIsCurrency0: boolean,
  rule: Launch2DynamicRoundCloseRule,
): boolean {
  return rule === "closeAtOrAboveOpen"
    ? !launch2DynamicIsRed(open, close, memeIsCurrency0)
    : launch2DynamicIsGreen(open, close, memeIsCurrency0);
}

/** `PriceMath.crashOverTenPercent` (exact, on encoded sqrt prices). */
export function launch2DynamicCrashOverTenPercent(
  open: bigint,
  close: bigint,
  memeIsCurrency0: boolean,
): boolean {
  const numerator = memeIsCurrency0 ? close : open;
  const denominator = memeIsCurrency0 ? open : close;
  return numerator * numerator * 10n < denominator * denominator * 9n;
}

/** `PriceMath.dropWad`: the candle's drop as an 18-decimal rate. */
export function launch2DynamicDropWad(
  open: bigint,
  current: bigint,
  memeIsCurrency0: boolean,
): bigint {
  if (open === current || launch2DynamicIsGreen(open, current, memeIsCurrency0))
    return 0n;
  const smaller = memeIsCurrency0 ? current : open;
  const larger = memeIsCurrency0 ? open : current;
  const ratioQ128 = mulDiv(smaller, q128, larger);
  const squaredQ128 = mulDivRoundingUp(ratioQ128, ratioQ128, q128);
  const retainedWad = mulDivRoundingUp(squaredQ128, launch2DynamicWad, q128);
  return launch2DynamicWad - retainedWad;
}

/** The Hook's accounting views the roll needs (one block). */
export interface Launch2DynamicCandleState {
  readonly initialized: boolean;
  readonly armed: boolean;
  readonly candleId: bigint;
  readonly candleOpenSqrtPriceX96: bigint;
  readonly lastSqrtPriceX96: bigint;
  readonly currentRoundId: bigint;
  readonly memeIsCurrency0: boolean;
  /** Decision 0144: the Hook generation's close rule. */
  readonly roundCloseRule: Launch2DynamicRoundCloseRule;
}

/**
 * `LoopAccounting._rollCandle` at `nowSeconds` (the next swap, poke, or
 * claim runs it first): whether the pending candle close activates a round
 * (red candle below −10 %) or closes the armed one (Decision 0144: a
 * candle that no longer falls, flat included, on an S193 Hook — also the
 * first skipped empty candle of a multi-candle gap; a green candle on a
 * pre-S193 Hook).
 */
export function launch2DynamicRoll(
  state: Launch2DynamicCandleState,
  nowSeconds: bigint,
): {
  readonly rollPending: boolean;
  readonly armed: boolean;
  readonly roundId: bigint;
  readonly activates: boolean;
  readonly closes: boolean;
  readonly candleOpenSqrtPriceX96: bigint;
} {
  const nowId = nowSeconds / launch2DynamicCandleSeconds;
  if (!state.initialized || nowId <= state.candleId) {
    return {
      rollPending: false,
      armed: state.armed,
      roundId: state.currentRoundId,
      activates: false,
      closes: false,
      candleOpenSqrtPriceX96: state.candleOpenSqrtPriceX96,
    };
  }
  let armed = state.armed;
  let roundId = state.currentRoundId;
  let activates = false;
  let closes = false;
  if (armed) {
    if (
      launch2DynamicClosesRound(
        state.candleOpenSqrtPriceX96,
        state.lastSqrtPriceX96,
        state.memeIsCurrency0,
        state.roundCloseRule,
      )
    ) {
      armed = false;
      closes = true;
    }
  } else if (
    launch2DynamicCrashOverTenPercent(
      state.candleOpenSqrtPriceX96,
      state.lastSqrtPriceX96,
      state.memeIsCurrency0,
    )
  ) {
    armed = true;
    roundId += 1n;
    activates = true;
  }
  // Decision 0144 (loop-contracts 0013 §2): the candles between the last
  // recorded one and now had no trade — flat (open = close). On an S193
  // Hook the first of them ends a round still armed (including one this
  // roll just activated: activate-then-close, start = end).
  if (
    armed &&
    state.roundCloseRule === "closeAtOrAboveOpen" &&
    nowId > state.candleId + 1n
  ) {
    armed = false;
    closes = true;
  }
  return {
    rollPending: true,
    armed,
    roundId,
    activates,
    closes,
    candleOpenSqrtPriceX96: state.lastSqrtPriceX96,
  };
}

/**
 * Decision 0152 (loop-contracts Decision 0015 §7): the v4 permission bits a
 * LoopDynamic Hook address carries — its generation, readable from the
 * address alone. Pre-S209 Hooks (`0x10C4`) take the 2 % buy fee from the
 * MEME output in `afterSwap`; S209 Hooks (`0x10CC`, + beforeSwapReturnDelta)
 * take it from the USD1 input in `beforeSwap`.
 */
export const launch2DynamicHookPermissionFlags = Object.freeze({
  meme: 0x10c4n,
  usd1: 0x10ccn,
} as const);

export type Launch2DynamicBuyFeeToken =
  keyof typeof launch2DynamicHookPermissionFlags;

/** The low 14 bits of a Hook address → its buy fee token; null = neither generation. */
export function launch2DynamicBuyFeeTokenOfHook(
  hook: string,
): Launch2DynamicBuyFeeToken | null {
  if (!/^0x[0-9a-fA-F]{40}$/u.test(hook)) return null;
  const flags = BigInt(hook) & 0x3fffn;
  if (flags === launch2DynamicHookPermissionFlags.usd1) return "usd1";
  if (flags === launch2DynamicHookPermissionFlags.meme) return "meme";
  return null;
}

/**
 * Decision 0152: a decoded `BuyFeeCharged` → its fee token. The S209 event
 * `(round, buyer, grossQuote, fee)` and the older `(buyer, grossMeme, fee)`
 * have different topic0s; the decoder keeps the argument names.
 */
export function launch2DynamicBuyFeeTokenOfLog(
  args: Readonly<Record<string, string>>,
): Launch2DynamicBuyFeeToken {
  return args["grossQuote"] !== undefined ? "usd1" : "meme";
}

/** `floor(gross × ppm / 1e6)`. */
export function launch2DynamicFeeOfGross(gross: bigint, ppm: bigint): bigint {
  return mulDiv(gross, ppm, ppmDenominator);
}

/**
 * Decision 0152: an S209 Hook's buy split of the USD1 input `amountIn` —
 * `fee = floor(amountIn × buyFeePpm / 1e6)` stays in the Hook
 * (`baseFeesAccrued`), the pool swaps `amountIn − fee`; the MEME output is
 * not taxed.
 */
export function launch2DynamicUsd1BuySplit(
  amountIn: bigint,
  buyFeePpm: bigint,
): { readonly fee: bigint; readonly poolInput: bigint } {
  const fee = launch2DynamicFeeOfGross(amountIn, buyFeePpm);
  return { fee, poolInput: amountIn - fee };
}

/**
 * The gross behind a net output `gross − floor(gross × ppm / 1e6)` (the
 * fee is taken from the output; pre-S209 buys). Two grosses can give the same net; the
 * larger is taken (the larger fee, at most 1 wei off the contract's).
 */
export function launch2DynamicGrossOfNet(net: bigint, ppm: bigint): bigint {
  if (ppm <= 0n) return net;
  const netOf = (gross: bigint): bigint =>
    gross - launch2DynamicFeeOfGross(gross, ppm);
  let gross = (net * ppmDenominator) / (ppmDenominator - ppm);
  while (gross > 0n && netOf(gross) > net) gross -= 1n;
  while (netOf(gross + 1n) <= net) gross += 1n;
  return gross;
}

/**
 * Decision 0144 (loop-contracts Decision 0012): the dynamic sell rate the
 * Hook charges for a candle drop — `min(drop, cap)`, `cap = 0` = uncapped
 * (pre-S193 Hooks and an uncapped S193 Factory). `SellFeeCharged.dropWad`
 * stays the real drop; this is the rate actually applied.
 */
export function launch2DynamicEffectiveRateWad(
  dropWad: bigint,
  maxDynamicFeeWad: bigint,
): bigint {
  return maxDynamicFeeWad !== 0n && dropWad > maxDynamicFeeWad
    ? maxDynamicFeeWad
    : dropWad;
}

/**
 * `LoopDynamicHook.afterSwap` sell branch: `extra = floor((gross − base) ×
 * min(drop, cap) / 1e18)`.
 */
export function launch2DynamicSellExtraFee(input: {
  readonly gross: bigint;
  readonly baseFee: bigint;
  readonly dropWad: bigint;
  readonly maxDynamicFeeWad: bigint;
}): bigint {
  if (input.gross <= input.baseFee) return 0n;
  return mulDiv(
    input.gross - input.baseFee,
    launch2DynamicEffectiveRateWad(input.dropWad, input.maxDynamicFeeWad),
    launch2DynamicWad,
  );
}

/**
 * The rate a `SellFeeCharged` log actually charged, from its amounts:
 * `extraFee × 1e18 / (grossQuote − baseFee)` (floor; ≤ 1 wei of rate below
 * `min(dropWad, cap)` because the Hook floors `extra`). Never use the
 * event's `dropWad` as the charged rate: it is the real drop (Decision
 * 0012 §1), above the rate whenever the cap applied.
 */
export function launch2DynamicRealizedRateWad(input: {
  readonly grossQuote: bigint;
  readonly baseFee: bigint;
  readonly extraFee: bigint;
}): bigint {
  if (input.grossQuote <= input.baseFee) return 0n;
  return mulDiv(
    input.extraFee,
    launch2DynamicWad,
    input.grossQuote - input.baseFee,
  );
}

/** An 18-decimal rate → bps (floor). */
export function launch2DynamicWadBps(wad: bigint): number {
  return Number((wad * 10_000n) / launch2DynamicWad);
}

/** ppm → bps (the Hook's ppm are whole bps: 20,000 ppm = 200 bps). */
export function launch2DynamicBps(ppm: bigint): number {
  return Number(ppm / 100n);
}

/**
 * A sell's fee split from two simulations of the same router call at one
 * block: `netActual` against the real Hook state, `netNeutral` with the
 * Hook overridden to "initialized, not armed, no candle to roll" (only the
 * base fee). The pool math is the same in both (the Hook fee is a delta
 * after the swap), so `netNeutral − netActual` is the dynamic fee exactly.
 */
export function launch2DynamicSellSplit(input: {
  readonly netActual: bigint;
  readonly netNeutral: bigint;
  readonly baseSellFeePpm: bigint;
}): {
  readonly gross: bigint;
  readonly baseFee: bigint;
  readonly dynamicFee: bigint;
  /**
   * Dynamic fee over the post-base amount, in bps, rounded to the nearest
   * bps. The Hook floors its fee to the wei, so a capped sell charges one
   * wei under 20 % and a floor here printed 1999 for it (S194 L1).
   */
  readonly dynamicTaxBps: number;
} {
  const dynamicFee =
    input.netNeutral > input.netActual
      ? input.netNeutral - input.netActual
      : 0n;
  const gross = launch2DynamicGrossOfNet(
    input.netNeutral,
    input.baseSellFeePpm,
  );
  const baseFee = gross - input.netNeutral;
  const dynamicTaxBps =
    input.netNeutral === 0n
      ? 0
      : Number(
          (dynamicFee * 10_000n + input.netNeutral / 2n) / input.netNeutral,
        );
  return { gross, baseFee, dynamicFee, dynamicTaxBps };
}

/** `LoopAccounting.claimable` from projected round facts (floor). */
export function launch2DynamicClaimable(input: {
  readonly allocation: bigint;
  readonly weight: bigint;
  readonly totalBuyWeight: bigint;
}): bigint {
  if (input.totalBuyWeight === 0n) return 0n;
  return mulDiv(input.allocation, input.weight, input.totalBuyWeight);
}

// ---------------------------------------------------------------------------
// Calldata
// ---------------------------------------------------------------------------

/** `LoopRouter.swapExactInput(key, zeroForOne, amountIn, minOut, limit, deadline)`. */
export function encodeLaunch2DynamicSwap(input: {
  readonly key: Launch2PoolKey;
  readonly zeroForOne: boolean;
  readonly amountIn: bigint;
  readonly minOut: bigint;
  readonly deadline: bigint;
}): Hex {
  return encodeFunctionData({
    abi: loopRouterAbi,
    functionName: "swapExactInput",
    args: [
      {
        currency0: input.key.currency0 as Hex,
        currency1: input.key.currency1 as Hex,
        fee: input.key.fee,
        tickSpacing: input.key.tickSpacing,
        hooks: input.key.hooks as Hex,
      },
      input.zeroForOne,
      input.amountIn,
      input.minOut,
      input.zeroForOne ? launch2MinSqrtPriceLimit : launch2MaxSqrtPriceLimit,
      input.deadline,
    ],
  });
}

/** `LoopDynamicHook.claim(roundId)`. */
export function encodeLaunch2DynamicClaim(roundId: bigint): Hex {
  return encodeFunctionData({
    abi: loopDynamicHookAbi,
    functionName: "claim",
    args: [roundId],
  });
}

/** `LoopDynamicHook.poke()`. */
export function encodeLaunch2DynamicPoke(): Hex {
  return encodeFunctionData({ abi: loopDynamicHookAbi, functionName: "poke" });
}

/** `priceTiming()` enum → wire string. */
export function launch2DynamicPriceTiming(
  value: number,
): "PRE_SWAP" | "POST_SWAP" {
  return value === 0 ? "PRE_SWAP" : "POST_SWAP";
}

/** `routingPolicy()` enum → wire string. */
export function launch2DynamicRoutingPolicy(
  value: number,
): "loopRouterOnly" | "open" {
  return value === 0 ? "loopRouterOnly" : "open";
}

/**
 * The storage slots of `LoopDynamicHook` (forge inspect storageLayout,
 * loop-contracts f711d58): slot 0 packs `initialized` (byte 0) and `armed`
 * (byte 1); slot 1 is `candleId`. A neutral simulation sets
 * `initialized = true, armed = false` and `candleId = 2^256 − 1` (the
 * candle never rolls), so the swap pays the base fee only.
 */
export const launch2DynamicNeutralHookSlots = Object.freeze([
  { slot: 0n, value: 1n },
  { slot: 1n, value: (1n << 256n) - 1n },
]);
