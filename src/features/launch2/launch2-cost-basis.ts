/**
 * Decision 0176: a wallet's cost and profit / loss of one MEME v2 position,
 * by the moving-average cost method.
 *
 * Input: the wallet's own trades of the instance in chain order — curve
 * `CurveBought` / `CurveSold` first, then its attributed official-pool
 * swaps (buybacks and reorged rows never reach here). Each trade carries
 * the MEME that moved and the USD1 the wallet actually paid (buy, taxes and
 * fees included) or actually received (sell, net of taxes and fees).
 *
 * - buy: cost += usd1 paid; quantity += MEME received.
 * - sell: the cost leaving = cost × sold / quantity (the average cost of
 *   the sold MEME); realized += usd1 received − that cost. Selling more
 *   than the traded quantity (MEME that came in by transfer) sells the
 *   excess at zero cost and marks the replay `oversold`.
 *
 * MEME moved by plain transfers is not a trade and has no cost: it never
 * enters the average. `launch2PositionPnlOf` reconciles the traded
 * quantity with the real holding afterwards.
 */

import { formatLaunch2Amount, launch2Wad } from "./launch2-contract.js";

export interface Launch2CostTrade {
  readonly side: "buy" | "sell";
  /** MEME received (buy) or given (sell), raw 18-decimal units. */
  readonly memeAmount: bigint;
  /** USD1 paid (buy, gross) or received (sell, net), raw 18-decimal units. */
  readonly usd1Amount: bigint;
}

export interface Launch2CostReplay {
  /** MEME bought minus MEME sold by trades (never below zero). */
  readonly quantity: bigint;
  /** USD1 cost of `quantity`. */
  readonly cost: bigint;
  /** Σ (USD1 received − average cost of the MEME sold); may be negative. */
  readonly realized: bigint;
  /** Some sell exceeded the traded quantity (transferred-in MEME sold). */
  readonly oversold: boolean;
  readonly tradeCount: number;
}

/** Decision 0176: replays the trades (chain order) with a moving average. */
export function replayLaunch2CostBasis(
  trades: readonly Launch2CostTrade[],
): Launch2CostReplay {
  let quantity = 0n;
  let cost = 0n;
  let realized = 0n;
  let oversold = false;
  for (const trade of trades) {
    if (trade.side === "buy") {
      quantity += trade.memeAmount;
      cost += trade.usd1Amount;
      continue;
    }
    const sold = trade.memeAmount;
    if (sold >= quantity) {
      if (sold > quantity) oversold = true;
      realized += trade.usd1Amount - cost;
      quantity = 0n;
      cost = 0n;
      continue;
    }
    const leaving = (cost * sold) / quantity;
    realized += trade.usd1Amount - leaving;
    cost -= leaving;
    quantity -= sold;
  }
  return Object.freeze({
    quantity,
    cost,
    realized,
    oversold,
    tradeCount: trades.length,
  });
}

/** The five optional keys (Decision 0176), all null without a trade. */
// A type alias (not an interface) so it spreads into a Resource.
export type Launch2PositionPnl = {
  readonly avgCostUsd1: string | null;
  readonly costBasisUsd1: string | null;
  readonly realizedPnlUsd1: string | null;
  readonly unrealizedPnlUsd1: string | null;
  readonly costCoverage: "full" | "partial" | null;
};

export const launch2EmptyPositionPnl: Launch2PositionPnl = Object.freeze({
  avgCostUsd1: null,
  costBasisUsd1: null,
  realizedPnlUsd1: null,
  unrealizedPnlUsd1: null,
  costCoverage: null,
});

/**
 * Decision 0176: the keys of one position.
 *
 * - `holding`: the quantity S280 values (`curve.net` before graduation,
 *   the live `memeBalance` after); null when it could not be read.
 * - `priceE18`: S280's price (curve price / pool last price); null or 0 =
 *   no price.
 *
 * avg = floor(cost × 1e18 / traded quantity) (null when nothing traded is
 * still held). Holding below the traded quantity (MEME transferred out)
 * keeps only `holding` at the average; holding above it (MEME transferred
 * in) adds no cost. costBasis = floor(avg-cost of min(holding, traded)).
 * unrealized = (price − avg) × holding / 1e18 (truncated toward zero; 0
 * with nothing held; null without a price, a holding or an average). Coverage is `full`
 * when the trades explain the holding exactly and nothing was oversold,
 * `partial` otherwise, null when the holding is unknown.
 */
export function launch2PositionPnlOf(input: {
  readonly replay: Launch2CostReplay | null;
  readonly holding: bigint | null;
  readonly priceE18: bigint | null;
}): Launch2PositionPnl {
  const replay = input.replay;
  if (replay === null || replay.tradeCount === 0) {
    return launch2EmptyPositionPnl;
  }
  const traded = replay.quantity;
  const avgE18 = traded === 0n ? null : (replay.cost * launch2Wad) / traded;
  const holding = input.holding;
  const held = holding === null ? traded : holding < traded ? holding : traded;
  const costBasis =
    traded === 0n
      ? 0n
      : held === traded
        ? replay.cost
        : (replay.cost * held) / traded;
  const price =
    input.priceE18 !== null && input.priceE18 > 0n ? input.priceE18 : null;
  let unrealized: bigint | null = null;
  if (holding === 0n) unrealized = 0n;
  else if (holding !== null && price !== null && avgE18 !== null) {
    unrealized = ((price - avgE18) * holding) / launch2Wad;
  }
  return Object.freeze({
    avgCostUsd1: avgE18 === null ? null : formatLaunch2Amount(avgE18),
    costBasisUsd1: formatLaunch2Amount(costBasis),
    realizedPnlUsd1: formatLaunch2Amount(replay.realized),
    unrealizedPnlUsd1:
      unrealized === null ? null : formatLaunch2Amount(unrealized),
    costCoverage:
      holding === null
        ? null
        : holding === traded && !replay.oversold
          ? "full"
          : "partial",
  });
}
