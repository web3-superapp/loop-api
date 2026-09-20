import { describe, expect, it } from "vitest";

import type { MiningFormulaDocument } from "../src/features/mining/mining-contract.js";
import {
  miningFormulaDocumentSchema,
  miningReferencePricingRuleSchema,
} from "../src/features/mining/mining-contract.js";
import {
  deriveDeclaredPairReferencePrice,
  deriveStableReferencePrice,
  invertQuoteTokenPrice,
  isDerivedPriceAllowed,
  isWithinReferencePriceGuard,
  referencePriceGuardBand,
} from "../src/features/mining/mining-reference-pricing.js";
import {
  computeMiningSnapshot,
  selectMiningPrice,
  type MiningBalanceInput,
  type MiningPriceInput,
} from "../src/features/mining/mining-snapshot.js";
import type { TokenPairSnapshot } from "../src/integrations/market/market-data-provider.js";

/**
 * Decision 0059: a formula version declares, per asset, how it may be priced
 * when no pair has it as the base token. The Development fact of 2026-09-20
 * is the case under test: DexScreener answers for BSC USDT with `WBNB/USDT`
 * and `USDT/USDC`, in which USDT is only the quote token.
 */

const usdt = "0x55d398326f99059ff775485246999027b3197955";
const wbnb = "0xbb4cdb9cbd36b01bd1cbaebf2de08d9173bc095c";
const usdtAssetId = `eip155:56:${usdt}`;
const wbnbPairAddress = "0x16b9a82891338f9ba80e2d6970fdda79d1eb0dae";
const otherPairAddress = "0x172fcd41e0913e95784454622d1c3724f546f849";

function pair(overrides: Partial<TokenPairSnapshot>): TokenPairSnapshot {
  return {
    pairAddress: wbnbPairAddress,
    dexId: "pancakeswap",
    labels: [],
    baseTokenAddress: wbnb,
    baseTokenSymbol: "WBNB",
    quoteTokenAddress: usdt,
    quoteTokenSymbol: "USDT",
    // WBNB is worth 860.5 USD and 860.9 USDT, so one USDT is 0.99953…
    priceUsd: "860.5",
    priceNative: "860.9",
    liquidityUsd: "1000000",
    volumeH24: null,
    priceChangeH24: null,
    fdv: null,
    marketCap: null,
    buysH24: null,
    sellsH24: null,
    pairCreatedAt: null,
    ...overrides,
  };
}

const stableRule = { kind: "stable", pegUsd: "1", guardBps: 200 } as const;

describe("reference pricing arithmetic (Decision 0059)", () => {
  it("inverts the quote side of a pair exactly and refuses a pair without both numbers", () => {
    expect(invertQuoteTokenPrice(pair({}))).toBe("0.999535369961668021");
    expect(invertQuoteTokenPrice({ priceUsd: "1", priceNative: "1" })).toBe(
      "1",
    );
    expect(
      invertQuoteTokenPrice({ priceUsd: "860.5", priceNative: null }),
    ).toBe(null);
    expect(invertQuoteTokenPrice({ priceUsd: null, priceNative: "1" })).toBe(
      null,
    );
    expect(invertQuoteTokenPrice({ priceUsd: "1", priceNative: "0" })).toBe(
      null,
    );
    expect(invertQuoteTokenPrice({ priceUsd: "0.0", priceNative: "1" })).toBe(
      null,
    );
  });

  it("computes the guard band as an exact decimal of the peg", () => {
    expect(referencePriceGuardBand("1", 200)).toBe("0.02");
    expect(referencePriceGuardBand("1", 500)).toBe("0.05");
    expect(referencePriceGuardBand("2.5", 1)).toBe("0.00025");
  });

  it("accepts a price inside the band on both sides and refuses the boundary case beyond it", () => {
    expect(isWithinReferencePriceGuard("0.98", "1", 200)).toBe(true);
    expect(isWithinReferencePriceGuard("1.02", "1", 200)).toBe(true);
    expect(isWithinReferencePriceGuard("0.979999", "1", 200)).toBe(false);
    expect(isWithinReferencePriceGuard("1.020001", "1", 200)).toBe(false);
    expect(isWithinReferencePriceGuard("0.9", "1", 200)).toBe(false);
    // A guard width outside 1..10000 bps is not a guard.
    expect(isWithinReferencePriceGuard("1", "1", 0)).toBe(false);
    expect(isWithinReferencePriceGuard("1", "1", 10_001)).toBe(false);
    expect(isWithinReferencePriceGuard("1", "0", 200)).toBe(false);
  });
});

describe("kind: stable (Decision 0059)", () => {
  it("inverts the deepest pair in which the asset is the quote token", () => {
    const result = deriveStableReferencePrice({
      rule: stableRule,
      tokenAddress: usdt,
      pairs: [
        pair({ pairAddress: otherPairAddress, liquidityUsd: "10" }),
        pair({ liquidityUsd: "1000000" }),
      ],
    });
    expect(result).toEqual({
      kind: "price",
      price: {
        priceUsd: "0.999535369961668021",
        pairAddress: wbnbPairAddress,
        inverted: true,
      },
    });
  });

  it("refuses a derived price outside the band and never falls back to the peg", () => {
    const result = deriveStableReferencePrice({
      rule: stableRule,
      // 860.5 USD / 700 USDT = 1.229… , 23 % away from the peg.
      pairs: [pair({ priceNative: "700" })],
      tokenAddress: usdt,
    });
    expect(result).toEqual({
      kind: "skip",
      reasonCode: "MINING_PRICE_PAIR_NOT_FOUND",
    });
  });

  it("ignores pairs in which the asset is the base token and answers PAIR_NOT_FOUND without a quote pair", () => {
    const result = deriveStableReferencePrice({
      rule: stableRule,
      tokenAddress: usdt,
      pairs: [
        pair({
          baseTokenAddress: usdt,
          quoteTokenAddress: wbnb,
          priceUsd: "1",
          priceNative: "0.00116",
        }),
      ],
    });
    expect(result).toEqual({
      kind: "skip",
      reasonCode: "MINING_PRICE_PAIR_NOT_FOUND",
    });
  });

  it("skips a quote pair whose numbers cannot be inverted", () => {
    expect(
      deriveStableReferencePrice({
        rule: stableRule,
        tokenAddress: usdt,
        pairs: [pair({ priceNative: null })],
      }),
    ).toEqual({ kind: "skip", reasonCode: "MINING_PRICE_PAIR_NOT_FOUND" });
  });
});

describe("kind: pair (Decision 0059)", () => {
  const baseRule = { kind: "pair", pairAddress: wbnbPairAddress } as const;

  it("takes the declared pair's own price when the asset is its base token", () => {
    expect(
      deriveDeclaredPairReferencePrice({
        rule: baseRule,
        tokenAddress: wbnb,
        pair: pair({}),
      }),
    ).toEqual({
      kind: "price",
      price: {
        priceUsd: "860.5",
        pairAddress: wbnbPairAddress,
        inverted: false,
      },
    });
  });

  it("inverts the declared pair when the asset is its quote token, but only with a declared peg", () => {
    expect(
      deriveDeclaredPairReferencePrice({
        rule: baseRule,
        tokenAddress: usdt,
        pair: pair({}),
      }),
    ).toEqual({ kind: "skip", reasonCode: "MINING_PRICE_PAIR_NOT_FOUND" });
    expect(
      deriveDeclaredPairReferencePrice({
        rule: { ...baseRule, pegUsd: "1" },
        tokenAddress: usdt,
        pair: pair({}),
      }),
    ).toEqual({
      kind: "price",
      price: {
        priceUsd: "0.999535369961668021",
        pairAddress: wbnbPairAddress,
        inverted: true,
      },
    });
    // The default width is 500 bps; 1.229 is outside it.
    expect(
      deriveDeclaredPairReferencePrice({
        rule: { ...baseRule, pegUsd: "1" },
        tokenAddress: usdt,
        pair: pair({ priceNative: "700" }),
      }),
    ).toEqual({ kind: "skip", reasonCode: "MINING_PRICE_PAIR_NOT_FOUND" });
  });

  it("refuses a missing pair, another pair, and a pair the asset is not part of", () => {
    for (const candidate of [
      null,
      pair({ pairAddress: otherPairAddress }),
      pair({ baseTokenAddress: wbnb, quoteTokenAddress: otherPairAddress }),
    ]) {
      expect(
        deriveDeclaredPairReferencePrice({
          rule: { ...baseRule, pegUsd: "1" },
          tokenAddress: usdt,
          pair: candidate,
        }),
      ).toEqual({ kind: "skip", reasonCode: "MINING_PRICE_PAIR_NOT_FOUND" });
    }
  });
});

describe("the version decides whether a derived price may be used", () => {
  const formula = (
    referencePricing?: MiningFormulaDocument["referencePricing"],
  ): MiningFormulaDocument => ({
    kind: "holding_times_reference_price_times_weight",
    expressionKey: "mining.rules.formula.holdingTimesReferencePriceTimesWeight",
    dailyOutputKey: "mining.rules.dailyOutput.shareOfNetworkPower",
    assetWeights: { [usdtAssetId]: "1" },
    referralBoost: { status: "pending_approval" },
    ...(referencePricing === undefined ? {} : { referencePricing }),
  });

  it("refuses a derived price for an asset the version declares no rule for", () => {
    expect(
      isDerivedPriceAllowed({
        assetId: usdtAssetId,
        formula: formula(),
        priceUsd: "0.9995",
        pairAddress: wbnbPairAddress,
        inverted: true,
      }),
    ).toBe(false);
  });

  it("refuses a derived price that names no pair, was not inverted, or names another pair than the rule", () => {
    const stable = formula({ [usdtAssetId]: stableRule });
    expect(
      isDerivedPriceAllowed({
        assetId: usdtAssetId,
        formula: stable,
        priceUsd: "0.9995",
        pairAddress: null,
        inverted: true,
      }),
    ).toBe(false);
    expect(
      isDerivedPriceAllowed({
        assetId: usdtAssetId,
        formula: stable,
        priceUsd: "0.9995",
        pairAddress: wbnbPairAddress,
        inverted: false,
      }),
    ).toBe(false);
    expect(
      isDerivedPriceAllowed({
        assetId: usdtAssetId,
        formula: formula({
          [usdtAssetId]: {
            kind: "pair",
            pairAddress: wbnbPairAddress,
            pegUsd: "1",
          },
        }),
        priceUsd: "0.9995",
        pairAddress: otherPairAddress,
        inverted: true,
      }),
    ).toBe(false);
  });

  it("accepts a declared, inverted, in-band price and refuses the same price out of band", () => {
    const stable = formula({ [usdtAssetId]: stableRule });
    expect(
      isDerivedPriceAllowed({
        assetId: usdtAssetId,
        formula: stable,
        priceUsd: "0.99953537",
        pairAddress: wbnbPairAddress,
        inverted: true,
      }),
    ).toBe(true);
    expect(
      isDerivedPriceAllowed({
        assetId: usdtAssetId,
        formula: stable,
        priceUsd: "1.2",
        pairAddress: wbnbPairAddress,
        inverted: true,
      }),
    ).toBe(false);
  });
});

describe("selectMiningPrice with a derived price (Decisions 0057 and 0059)", () => {
  const document: MiningFormulaDocument = {
    kind: "holding_times_reference_price_times_weight",
    expressionKey: "mining.rules.formula.holdingTimesReferencePriceTimesWeight",
    dailyOutputKey: "mining.rules.dailyOutput.shareOfNetworkPower",
    assetWeights: { [usdtAssetId]: "1" },
    referralBoost: { status: "pending_approval" },
    referencePricing: { [usdtAssetId]: stableRule },
  };

  const derivedPrice: MiningPriceInput = {
    assetId: usdtAssetId,
    priceUsd: "0.99953537",
    quality: "derived",
    fetchedAt: "2026-09-20T14:00:00.000Z",
    source: "dexscreener",
    proxyAssetId: null,
    pairAddress: wbnbPairAddress,
    derivedInverted: true,
  };

  it("carries an in-band derived price with its pair", () => {
    expect(selectMiningPrice(usdtAssetId, document, [derivedPrice])).toEqual({
      kind: "price",
      priceUsd: "0.99953537",
      fetchedAt: "2026-09-20T14:00:00.000Z",
      source: "dexscreener",
      quality: "derived",
      proxyAssetId: null,
      pairAddress: wbnbPairAddress,
    });
  });

  it("refuses an out-of-band derived price with MINING_PRICE_PAIR_NOT_FOUND", () => {
    expect(
      selectMiningPrice(usdtAssetId, document, [
        { ...derivedPrice, priceUsd: "1.2" },
      ]),
    ).toEqual({ kind: "skip", reasonCode: "MINING_PRICE_PAIR_NOT_FOUND" });
  });

  it("refuses a derived price the version declares no rule for", () => {
    const undeclared: MiningFormulaDocument = {
      ...document,
      referencePricing: {},
    };
    expect(selectMiningPrice(usdtAssetId, undeclared, [derivedPrice])).toEqual({
      kind: "skip",
      reasonCode: "MINING_PRICE_PAIR_NOT_FOUND",
    });
  });

  it("leaves an asset without a rule on the base-token-only rule of Decision 0036", () => {
    const other = "eip155:56:0x0000000000000000000000000000000000000001";
    const document2: MiningFormulaDocument = {
      ...document,
      assetWeights: { [other]: "1" },
    };
    expect(
      selectMiningPrice(other, document2, [
        {
          assetId: other,
          priceUsd: null,
          quality: "fresh",
          fetchedAt: "2026-09-20T14:00:00.000Z",
          source: "dexscreener",
          proxyAssetId: null,
        },
      ]),
    ).toEqual({ kind: "skip", reasonCode: "MINING_PRICE_PAIR_NOT_FOUND" });
    expect(
      selectMiningPrice(other, document2, [
        {
          assetId: other,
          priceUsd: "0.25",
          quality: "fresh",
          fetchedAt: "2026-09-20T14:00:00.000Z",
          source: "dexscreener",
          proxyAssetId: null,
          pairAddress: otherPairAddress,
        },
      ]),
    ).toMatchObject({ kind: "price", quality: "fresh", priceUsd: "0.25" });
  });

  it("values a real holding through the derived price and records the pair on the power row", () => {
    const balance: MiningBalanceInput = {
      ownerUserId: "3bb58597-9e39-4f06-9bd6-0b0f0c2b7c11",
      walletId: "d60627ca-4a5b-4a6e-9f2b-9a1b2c3d4e5f",
      assetId: usdtAssetId,
      decimals: 18,
      rawValue: "2990000000000000000",
      blockNumber: "123001455",
      blockHash: `0x${"a".repeat(64)}`,
    };
    const result = computeMiningSnapshot(
      { balances: [balance], prices: [derivedPrice], communityWeights: [] },
      { configVersion: "miningFormulaTestOnly", document },
    );
    expect(result.kind).toBe("computed");
    if (result.kind !== "computed") {
      return;
    }
    expect(result.powers).toEqual([
      {
        ownerUserId: balance.ownerUserId,
        assetId: usdtAssetId,
        holding: "2.99",
        referencePriceUsd: "0.99953537",
        referencePriceQuality: "derived",
        referencePriceProxyAssetId: null,
        referencePricePairAddress: wbnbPairAddress,
        weight: "1",
        power: "2.9886107563",
        blockNumber: "123001455",
      },
    ]);
    expect(result.totalPower).toBe("2.9886107563");
  });

  it("records the holding as unread when the derived price is out of band (Decision 0057)", () => {
    const result = computeMiningSnapshot(
      {
        balances: [
          {
            ownerUserId: "3bb58597-9e39-4f06-9bd6-0b0f0c2b7c11",
            walletId: "d60627ca-4a5b-4a6e-9f2b-9a1b2c3d4e5f",
            assetId: usdtAssetId,
            decimals: 18,
            rawValue: "2990000000000000000",
            blockNumber: "123001455",
            blockHash: `0x${"a".repeat(64)}`,
          },
        ],
        prices: [{ ...derivedPrice, priceUsd: "1.2" }],
        communityWeights: [],
      },
      { configVersion: "miningFormulaTestOnly", document },
    );
    expect(result).toMatchObject({
      kind: "incomplete",
      unread: [
        { assetId: usdtAssetId, reasonCode: "MINING_PRICE_PAIR_NOT_FOUND" },
      ],
    });
  });
});

describe("the rule is part of the versioned formula document", () => {
  it("parses both kinds and refuses a rule that is not one of them", () => {
    expect(miningReferencePricingRuleSchema.safeParse(stableRule).success).toBe(
      true,
    );
    expect(
      miningReferencePricingRuleSchema.safeParse({
        kind: "pair",
        pairAddress: wbnbPairAddress,
      }).success,
    ).toBe(true);
    expect(
      miningReferencePricingRuleSchema.safeParse({
        kind: "stable",
        pegUsd: "0",
        guardBps: 200,
      }).success,
    ).toBe(false);
    expect(
      miningReferencePricingRuleSchema.safeParse({
        kind: "stable",
        pegUsd: "1",
        guardBps: 0,
      }).success,
    ).toBe(false);
    expect(
      miningReferencePricingRuleSchema.safeParse({
        kind: "pair",
        pairAddress: wbnbPairAddress.toUpperCase(),
      }).success,
    ).toBe(false);
    expect(
      miningReferencePricingRuleSchema.safeParse({ kind: "peg", pegUsd: "1" })
        .success,
    ).toBe(false);
  });

  it("round-trips inside a formula document", () => {
    const parsed = miningFormulaDocumentSchema.parse({
      kind: "holding_times_reference_price_times_weight",
      expressionKey:
        "mining.rules.formula.holdingTimesReferencePriceTimesWeight",
      dailyOutputKey: "mining.rules.dailyOutput.shareOfNetworkPower",
      assetWeights: { [usdtAssetId]: "1" },
      referralBoost: { status: "pending_approval" },
      referencePricing: { [usdtAssetId]: stableRule },
    });
    expect(parsed.referencePricing?.[usdtAssetId]).toEqual(stableRule);
  });
});
