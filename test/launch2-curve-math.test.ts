import { describe, expect, it } from "vitest";

import {
  formatLaunch2Amount,
  launch2Template,
  parseLaunch2Amount,
} from "../src/features/launch2/launch2-contract.js";
import {
  launch2FloorBps,
  launch2GrossForNet,
  launch2Max,
  launch2PriceAt,
  launch2QuoteBuy,
  launch2QuoteMaxBuy,
  launch2QuoteSell,
  launch2ReserveAt,
  type Launch2CurveState,
} from "../src/features/launch2/launch2-curve-math.js";

/**
 * Decision 0114: the BigInt port of CurveMath / CurveEngine. The anvil
 * suite compares these numbers with the deployed contract's views.
 */

const wad = 10n ** 18n;
const sale = launch2Template.curveSaleSupply;
const cap = launch2Template.perAddressCap;

function state(overrides: Partial<Launch2CurveState> = {}): Launch2CurveState {
  const soldSupply = overrides.soldSupply ?? 0n;
  return {
    published: true,
    graduated: false,
    earlyRoundEndsAt: 2_000_000_000n,
    soldSupply,
    accountedReserve: launch2ReserveAt(soldSupply),
    blockTimestamp: 1_999_999_000n,
    ...overrides,
  };
}

describe("launch2 curve math (Decision 0114)", () => {
  it("reproduces the template: reserve at 800M is the graduation reserve, 16x price", () => {
    expect(launch2ReserveAt(0n)).toBe(0n);
    expect(launch2ReserveAt(sale)).toBe(launch2Template.graduationReserve);
    expect(formatLaunch2Amount(launch2PriceAt(0n))).toBe("0.00004166666625");
    expect(formatLaunch2Amount(launch2PriceAt(sale))).toBe("0.00066666666");
    expect(launch2PriceAt(sale) / launch2PriceAt(0n)).toBe(16n);
  });

  it("grosses up a net reserve like CurveEngine._grossForNet (ceil, then step)", () => {
    for (const net of [1n, 9n, 10n ** 18n, 123_456_789_012_345_678_901n]) {
      const gross = launch2GrossForNet(net);
      expect(gross - launch2FloorBps(gross, 1_000n)).toBeGreaterThanOrEqual(
        net,
      );
      expect(gross).toBeGreaterThanOrEqual((net * 10_000n + 8_999n) / 9_000n);
    }
    expect(launch2GrossForNet(0n)).toBe(0n);
  });

  it("MAX by quota: a fresh wallet can buy at most 0.5% = 5,000,000 MEME", () => {
    const max = launch2Max({
      side: "buy",
      state: state(),
      cumulativeBought: 0n,
      balance: null,
    });
    expect(max.limitedBy).toBe("quota");
    expect(max.amountOut).toBe(cap);
    expect(max.amountIn).toBe(launch2GrossForNet(launch2ReserveAt(cap)));
    // The same at a wallet that already used most of its quota.
    const nearly = launch2QuoteMaxBuy(state(), cap - 1_000n * wad);
    expect(nearly.limitedBy).toBe("quota");
    expect(nearly.maxMemeOut).toBe(1_000n * wad);
    // Selling never restores it: exhausted is exhausted.
    const done = launch2QuoteMaxBuy(state(), cap);
    expect(done.maxMemeOut).toBe(0n);
    expect(done.maxUsd1In).toBe(0n);
    expect(done.limitedBy).toBe("quota");
  });

  it("MAX by inventory: near the end the remaining supply binds", () => {
    const soldSupply = sale - 1_000n * wad;
    const max = launch2Max({
      side: "buy",
      state: state({ soldSupply }),
      cumulativeBought: 0n,
      balance: null,
    });
    expect(max.limitedBy).toBe("inventory");
    expect(max.amountOut).toBe(1_000n * wad);
    expect(max.amountIn).toBe(
      launch2GrossForNet(launch2ReserveAt(sale) - launch2ReserveAt(soldSupply)),
    );
    // Buying it lands exactly on 800M (the graduation trigger).
    const quote = launch2QuoteBuy(state({ soldSupply }), 0n, max.amountIn);
    expect(quote.nextSoldSupply).toBe(sale);
    // Only the contract's rounding dust (curveNet − reserveIn) comes back.
    expect(quote.usd1Accepted + quote.usd1Refund).toBe(max.amountIn);
    expect(quote.usd1Refund).toBeLessThanOrEqual(1n);
  });

  it("MAX by balance (curve price + tax): the wallet's USD1 binds below the quota", () => {
    const balance = 10n * wad;
    const max = launch2Max({
      side: "buy",
      state: state(),
      cumulativeBought: 0n,
      balance,
    });
    expect(max.limitedBy).toBe("balance");
    expect(max.amountIn).toBe(balance);
    const quote = launch2QuoteBuy(state(), 0n, balance);
    expect(max.amountOut).toBe(quote.memeOut);
    // 10 % tax on the accepted gross, the remainder reaches the curve.
    expect(quote.platformTax).toBe(launch2FloorBps(quote.usd1Accepted, 1_000n));
    expect(quote.usd1Accepted).toBe(quote.reserveIn + quote.platformTax);
    expect(quote.usd1Accepted + quote.usd1Refund).toBe(balance);
    expect(quote.memeOut).toBeGreaterThan(200_000n * wad);
    expect(quote.memeOut).toBeLessThan(240_000n * wad);
  });

  it("pins an over-MAX amount to the executable maximum and refunds the rest", () => {
    const max = launch2QuoteMaxBuy(state(), 0n);
    const quote = launch2QuoteBuy(state(), 0n, max.maxUsd1In + 1_000n * wad);
    expect(quote.memeOut).toBe(cap);
    expect(quote.usd1Refund).toBeGreaterThanOrEqual(1_000n * wad);
  });

  it("is closed before publication, before the snapshot, and after graduation", () => {
    for (const closed of [
      state({ published: false }),
      state({ earlyRoundEndsAt: 0n }),
      state({ graduated: true }),
    ]) {
      expect(launch2QuoteMaxBuy(closed, 0n).limitedBy).toBe("closed");
      expect(launch2QuoteBuy(closed, 0n, wad).memeOut).toBe(0n);
    }
  });

  it("sells only after the priority hour, bounded by balance or sold supply", () => {
    const soldSupply = 3_000_000n * wad;
    const inPriority = launch2Max({
      side: "sell",
      state: state({ soldSupply }),
      cumulativeBought: 0n,
      balance: wad,
    });
    expect(inPriority).toEqual({
      side: "sell",
      amountIn: 0n,
      amountOut: 0n,
      limitedBy: "closed",
    });
    const open = state({ soldSupply, blockTimestamp: 2_000_000_000n });
    const byBalance = launch2Max({
      side: "sell",
      state: open,
      cumulativeBought: 0n,
      balance: wad * 1_000n,
    });
    expect(byBalance.limitedBy).toBe("balance");
    expect(byBalance.amountIn).toBe(wad * 1_000n);
    const sell = launch2QuoteSell(soldSupply, wad * 1_000n);
    expect(byBalance.amountOut).toBe(sell.usd1Out);
    expect(sell.platformTax).toBe(
      launch2FloorBps(sell.usd1Out + sell.platformTax, 1_000n),
    );
    const bySold = launch2Max({
      side: "sell",
      state: open,
      cumulativeBought: 0n,
      balance: soldSupply * 2n,
    });
    expect(bySold.limitedBy).toBe("sold_supply");
    expect(bySold.amountIn).toBe(soldSupply);
    expect(() => launch2QuoteSell(soldSupply, soldSupply + 1n)).toThrow();
  });

  it("parses and formats 18-decimal amounts without JS numbers", () => {
    expect(parseLaunch2Amount("100")).toBe(100n * wad);
    expect(parseLaunch2Amount("0.000000000000000001")).toBe(1n);
    expect(parseLaunch2Amount("1.0000000000000000001")).toBeNull();
    expect(parseLaunch2Amount("-1")).toBeNull();
    expect(parseLaunch2Amount(1)).toBeNull();
    expect(formatLaunch2Amount(133_333_332n * 10n ** 15n)).toBe("133333.332");
  });
});
