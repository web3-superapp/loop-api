import { describe, expect, it } from "vitest";

import {
  launch2EmptyPositionPnl,
  launch2PositionPnlOf,
  replayLaunch2CostBasis,
  type Launch2CostTrade,
} from "../src/features/launch2/launch2-cost-basis.js";

/** Decision 0176: the moving-average cost replay (pure). */

const wad = 10n ** 18n;
const buy = (meme: bigint, usd1: bigint): Launch2CostTrade => ({
  side: "buy",
  memeAmount: meme * wad,
  usd1Amount: usd1 * wad,
});
const sell = (meme: bigint, usd1: bigint): Launch2CostTrade => ({
  side: "sell",
  memeAmount: meme * wad,
  usd1Amount: usd1 * wad,
});
/** USD1 per MEME as an e18 integer from a decimal string. */
const priceE18 = (value: string): bigint => {
  const [whole, fraction = ""] = value.split(".");
  return BigInt(whole!) * wad + BigInt(fraction.padEnd(18, "0"));
};

describe("replayLaunch2CostBasis (Decision 0176)", () => {
  it("buys only: cost = USD1 paid, quantity = MEME received, nothing realized", () => {
    const replay = replayLaunch2CostBasis([buy(1_000n, 10n), buy(1_000n, 30n)]);
    expect(replay).toEqual({
      quantity: 2_000n * wad,
      cost: 40n * wad,
      realized: 0n,
      oversold: false,
      tradeCount: 2,
    });
    const pnl = launch2PositionPnlOf({
      replay,
      holding: 2_000n * wad,
      priceE18: priceE18("0.03"),
    });
    expect(pnl).toEqual({
      avgCostUsd1: "0.02",
      costBasisUsd1: "40",
      realizedPnlUsd1: "0",
      unrealizedPnlUsd1: "20",
      costCoverage: "full",
    });
  });

  it("partial sell: cost leaves at the average, realized = net received − that cost", () => {
    // avg 0.02; sell 500 for 15 → cost leaving 10, realized +5.
    const replay = replayLaunch2CostBasis([
      buy(1_000n, 10n),
      buy(1_000n, 30n),
      sell(500n, 15n),
    ]);
    expect(replay.quantity).toBe(1_500n * wad);
    expect(replay.cost).toBe(30n * wad);
    expect(replay.realized).toBe(5n * wad);
    const pnl = launch2PositionPnlOf({
      replay,
      holding: 1_500n * wad,
      priceE18: priceE18("0.01"),
    });
    // Average unchanged by a sell; the price fell below it.
    expect(pnl).toEqual({
      avgCostUsd1: "0.02",
      costBasisUsd1: "30",
      realizedPnlUsd1: "5",
      unrealizedPnlUsd1: "-15",
      costCoverage: "full",
    });
  });

  it("sells everything and buys again: the second average starts from zero", () => {
    const replay = replayLaunch2CostBasis([
      buy(1_000n, 10n),
      sell(1_000n, 8n),
      buy(100n, 5n),
    ]);
    expect(replay.quantity).toBe(100n * wad);
    expect(replay.cost).toBe(5n * wad);
    expect(replay.realized).toBe(-2n * wad);
    expect(
      launch2PositionPnlOf({
        replay,
        holding: 100n * wad,
        priceE18: priceE18("0.05"),
      }),
    ).toEqual({
      avgCostUsd1: "0.05",
      costBasisUsd1: "5",
      realizedPnlUsd1: "-2",
      unrealizedPnlUsd1: "0",
      costCoverage: "full",
    });
  });

  it("all sold: average null, cost basis 0, unrealized 0 even without a price", () => {
    const replay = replayLaunch2CostBasis([
      buy(1_000n, 10n),
      sell(1_000n, 12n),
    ]);
    expect(
      launch2PositionPnlOf({ replay, holding: 0n, priceE18: null }),
    ).toEqual({
      avgCostUsd1: null,
      costBasisUsd1: "0",
      realizedPnlUsd1: "2",
      unrealizedPnlUsd1: "0",
      costCoverage: "full",
    });
  });

  it("taxes: the buy cost includes the tax and the sell proceeds are net of it", () => {
    // Buy: 100 USD1 reserve + 1 tax = 101 paid for 1 000 MEME.
    // Sell 1 000: 120 gross − 1.2 tax = 118.8 received.
    const replay = replayLaunch2CostBasis([
      { side: "buy", memeAmount: 1_000n * wad, usd1Amount: 101n * wad },
      {
        side: "sell",
        memeAmount: 1_000n * wad,
        usd1Amount: 1188n * 10n ** 17n,
      },
    ]);
    expect(
      launch2PositionPnlOf({ replay, holding: 0n, priceE18: priceE18("0.12") })
        .realizedPnlUsd1,
    ).toBe("17.8");
  });

  it("a loss is a negative decimal string", () => {
    const replay = replayLaunch2CostBasis([buy(3n, 10n), sell(1n, 1n)]);
    // avg 10/3; one sold for 1 → cost leaving floor(10e18/3), realized < 0.
    const pnl = launch2PositionPnlOf({
      replay,
      holding: 2n * wad,
      priceE18: priceE18("1"),
    });
    expect(pnl.realizedPnlUsd1).toBe("-2.333333333333333333");
    expect(pnl.avgCostUsd1).toBe("3.333333333333333333");
    expect(pnl.costBasisUsd1).toBe("6.666666666666666667");
    expect(pnl.unrealizedPnlUsd1).toBe("-4.666666666666666666");
  });

  it("transfer in: holding above the traded quantity adds no cost and is partial", () => {
    const replay = replayLaunch2CostBasis([buy(1_000n, 10n)]);
    expect(
      launch2PositionPnlOf({
        replay,
        holding: 1_500n * wad,
        priceE18: priceE18("0.02"),
      }),
    ).toEqual({
      avgCostUsd1: "0.01",
      costBasisUsd1: "10",
      realizedPnlUsd1: "0",
      unrealizedPnlUsd1: "15",
      costCoverage: "partial",
    });
  });

  it("transfer out: holding below the traded quantity keeps only its share of the cost, no PnL", () => {
    const replay = replayLaunch2CostBasis([buy(1_000n, 10n)]);
    expect(
      launch2PositionPnlOf({
        replay,
        holding: 400n * wad,
        priceE18: priceE18("0.01"),
      }),
    ).toEqual({
      avgCostUsd1: "0.01",
      costBasisUsd1: "4",
      realizedPnlUsd1: "0",
      unrealizedPnlUsd1: "0",
      costCoverage: "partial",
    });
  });

  it("selling transferred-in MEME beyond the traded quantity sells it at zero cost and is partial", () => {
    const replay = replayLaunch2CostBasis([buy(100n, 10n), sell(150n, 30n)]);
    expect(replay.oversold).toBe(true);
    expect(replay.realized).toBe(20n * wad);
    expect(
      launch2PositionPnlOf({ replay, holding: 0n, priceE18: null })
        .costCoverage,
    ).toBe("partial");
  });

  it("no trade: every key null; an unreadable holding: coverage and unrealized null", () => {
    expect(
      launch2PositionPnlOf({ replay: null, holding: 5n, priceE18: 1n }),
    ).toEqual(launch2EmptyPositionPnl);
    expect(
      launch2PositionPnlOf({
        replay: replayLaunch2CostBasis([]),
        holding: 5n,
        priceE18: 1n,
      }),
    ).toEqual(launch2EmptyPositionPnl);
    const replay = replayLaunch2CostBasis([buy(1_000n, 10n)]);
    expect(
      launch2PositionPnlOf({
        replay,
        holding: null,
        priceE18: priceE18("0.02"),
      }),
    ).toEqual({
      avgCostUsd1: "0.01",
      costBasisUsd1: "10",
      realizedPnlUsd1: "0",
      unrealizedPnlUsd1: null,
      costCoverage: null,
    });
    // No price (or a zero price): unrealized null, the rest unchanged.
    for (const price of [null, 0n]) {
      expect(
        launch2PositionPnlOf({ replay, holding: 1_000n * wad, priceE18: price })
          .unrealizedPnlUsd1,
      ).toBeNull();
    }
  });
});
