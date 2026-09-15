import { describe, expect, it } from "vitest";

import type { MiningFormulaDocument } from "../src/features/mining/mining-contract.js";
import { buildMiningDevBaselineDocuments } from "../src/features/mining/mining-dev-baseline.js";
import {
  computeMiningSnapshot,
  scaleRawHolding,
  type MiningBalanceInput,
  type MiningPriceInput,
} from "../src/features/mining/mining-snapshot.js";

/**
 * TEST-ONLY formula fixture. The numbers below are not an approved product
 * rule: no `approved` formula exists (Decision 0036 / 03 §19). They exist
 * only to exercise the pure computation.
 */
const testOnlyFormula: {
  readonly configVersion: string;
  readonly document: MiningFormulaDocument;
} = {
  configVersion: "miningFormulaTestOnly",
  document: {
    kind: "holding_times_reference_price_times_weight",
    expressionKey: "mining.rules.formula.holdingTimesReferencePriceTimesWeight",
    dailyOutputKey: "mining.rules.dailyOutput.shareOfNetworkPower",
    assetWeights: {
      "eip155:56:0x0000000000000000000000000000000000000001": "1",
    },
    referralBoost: { status: "pending_approval" },
  },
};

const loopAsset = "eip155:56:0x0000000000000000000000000000000000000001";
const communityAsset = "eip155:56:0x0000000000000000000000000000000000000002";
const unweightedAsset = "eip155:56:0x0000000000000000000000000000000000000003";
const pendingAsset = "eip155:56:0x0000000000000000000000000000000000000004";
const ambiguousAsset = "eip155:56:0x0000000000000000000000000000000000000005";
const alice = "6d12a86e-4134-47e6-9312-c5ef75a30f55";
const bob = "1a2b3c4d-5e6f-4a8b-9c0d-1e2f3a4b5c6d";
const hash = `0x${"a".repeat(64)}`;

function balance(
  ownerUserId: string,
  assetId: string,
  rawValue: string,
  blockNumber = "100",
): MiningBalanceInput {
  return {
    ownerUserId,
    walletId: "d64786bb-408d-415d-8a69-6277d56c921b",
    assetId,
    decimals: 18,
    rawValue,
    blockNumber,
    blockHash: hash,
  };
}

function price(
  assetId: string,
  priceUsd: string | null,
  quality: MiningPriceInput["quality"] = "fresh",
  fetchedAt = "2026-09-08T00:00:00.000Z",
  proxyAssetId: string | null = null,
): MiningPriceInput {
  return {
    assetId,
    priceUsd,
    quality,
    fetchedAt,
    source: "dexscreener",
    proxyAssetId,
  };
}
const nativeAsset = "eip155:56:native";
const wbnbAsset = "eip155:56:0xbb4cdb9cbd36b01bd1cbaebf2de08d9173bc095c";

describe("scaleRawHolding", () => {
  it("scales smallest units exactly without floating point", () => {
    expect(scaleRawHolding("1500000000000000000", 18)).toBe("1.5");
    expect(scaleRawHolding("1", 18)).toBe("0.000000000000000001");
    expect(scaleRawHolding("123456", 0)).toBe("123456");
    expect(() => scaleRawHolding("1.5", 18)).toThrow();
  });
});

describe("computeMiningSnapshot (pure)", () => {
  it("computes holding × fresh reference price × weight per account and asset", () => {
    const result = computeMiningSnapshot(
      {
        balances: [
          balance(alice, loopAsset, "2000000000000000000", "120"),
          balance(bob, loopAsset, "500000000000000000", "118"),
        ],
        prices: [price(loopAsset, "0.25")],
        communityWeights: [],
      },
      testOnlyFormula,
    );
    expect(result.kind).toBe("computed");
    if (result.kind !== "computed") {
      return;
    }
    expect(result.blockNumber).toBe("120");
    expect(result.blockHash).toBe(hash);
    expect(result.formulaVersion).toBe("miningFormulaTestOnly");
    expect(result.priceVersion).toBe("dexscreener:2026-09-08T00:00:00.000Z");
    expect(result.powers).toEqual([
      {
        ownerUserId: bob,
        assetId: loopAsset,
        holding: "0.5",
        referencePriceUsd: "0.25",
        referencePriceQuality: "fresh",
        referencePriceProxyAssetId: null,
        weight: "1",
        power: "0.125",
        blockNumber: "118",
      },
      {
        ownerUserId: alice,
        assetId: loopAsset,
        holding: "2",
        referencePriceUsd: "0.25",
        referencePriceQuality: "fresh",
        referencePriceProxyAssetId: null,
        weight: "1",
        power: "0.5",
        blockNumber: "120",
      },
    ]);
    expect(result.totalPower).toBe("0.625");
    expect(result.skipped).toEqual([]);
  });

  it("multiplies the asset weight by exactly one approved community weight and skips pending, ambiguous, and unweighted assets (Decision 0043)", () => {
    const formula = {
      configVersion: "miningFormulaTestOnly",
      document: {
        ...testOnlyFormula.document,
        assetWeights: {
          [loopAsset]: "1",
          [communityAsset]: "1",
          [pendingAsset]: "1",
          [ambiguousAsset]: "1",
        },
      },
    };
    const result = computeMiningSnapshot(
      {
        balances: [
          // 10 × $2 × (1 × 0.5) = 10
          balance(alice, communityAsset, "10000000000000000000"),
          // bound, weight under review → excluded
          balance(alice, pendingAsset, "10000000000000000000"),
          // two approved bindings → excluded
          balance(alice, ambiguousAsset, "10000000000000000000"),
          // not in assetWeights → excluded
          balance(alice, unweightedAsset, "10000000000000000000"),
          // unbound: asset weight alone; 3 × $4 × 1 = 12
          balance(alice, loopAsset, "3000000000000000000"),
        ],
        prices: [
          price(communityAsset, "2"),
          price(pendingAsset, "99"),
          price(ambiguousAsset, "99"),
          price(unweightedAsset, "99"),
          price(loopAsset, "4"),
        ],
        communityWeights: [
          {
            communityId: "3fa85f64-5717-4562-b3fc-2c963f66afa6",
            assetId: communityAsset,
            weight: "0.5",
            status: "approved",
          },
          {
            communityId: "9c1f0f2e-5a7b-4c3d-8e9f-0a1b2c3d4e5f",
            assetId: pendingAsset,
            weight: null,
            status: "pending_review",
          },
          {
            communityId: "0b2c1d3e-4f5a-4b6c-8d7e-9f0a1b2c3d4e",
            assetId: ambiguousAsset,
            weight: "2",
            status: "approved",
          },
          {
            communityId: "d64786bb-408d-415d-8a69-6277d56c921b",
            assetId: ambiguousAsset,
            weight: "0.5",
            status: "approved",
          },
        ],
      },
      formula,
    );
    expect(result.kind).toBe("computed");
    if (result.kind !== "computed") {
      return;
    }
    expect(result.powers).toEqual([
      {
        ownerUserId: alice,
        assetId: loopAsset,
        holding: "3",
        referencePriceUsd: "4",
        referencePriceQuality: "fresh",
        referencePriceProxyAssetId: null,
        weight: "1",
        power: "12",
        blockNumber: "100",
      },
      {
        ownerUserId: alice,
        assetId: communityAsset,
        holding: "10",
        referencePriceUsd: "2",
        referencePriceQuality: "fresh",
        referencePriceProxyAssetId: null,
        weight: "0.5",
        power: "10",
        blockNumber: "100",
      },
    ]);
    expect(result.totalPower).toBe("22");
    expect(result.skipped).toEqual([
      { assetId: pendingAsset, reasonCode: "COMMUNITY_WEIGHT_PENDING_REVIEW" },
      { assetId: ambiguousAsset, reasonCode: "COMMUNITY_WEIGHT_AMBIGUOUS" },
      {
        assetId: unweightedAsset,
        reasonCode: "MINING_ASSET_WEIGHT_NOT_CONFIGURED",
      },
    ]);
  });

  it("never lets a community weight stand in for a missing asset weight", () => {
    // The product draft weights nothing, so an approved community weight
    // alone computes nothing: the draft cannot produce a number by accident.
    const result = computeMiningSnapshot(
      {
        balances: [balance(alice, communityAsset, "10000000000000000000")],
        prices: [price(communityAsset, "2")],
        communityWeights: [
          {
            communityId: "3fa85f64-5717-4562-b3fc-2c963f66afa6",
            assetId: communityAsset,
            weight: "0.5",
            status: "approved",
          },
        ],
      },
      {
        configVersion: "miningFormulaV1-draft",
        document: { ...testOnlyFormula.document, assetWeights: {} },
      },
    );
    expect(result).toEqual({
      kind: "unavailable",
      reasonCode: "MINING_ASSET_WEIGHT_NOT_CONFIGURED",
      skipped: [
        {
          assetId: communityAsset,
          reasonCode: "MINING_ASSET_WEIGHT_NOT_CONFIGURED",
        },
      ],
    });
  });

  it("computes the development baseline as the USD value of the holdings (hand-checked)", () => {
    // Decision 0043: every registered asset weighs 1, so power is holding ×
    // reference price. Expected values are written by hand, not derived.
    const baseline = buildMiningDevBaselineDocuments([
      loopAsset,
      communityAsset,
    ]);
    const result = computeMiningSnapshot(
      {
        balances: [
          // 1.5 × 720.78 = 1081.17
          balance(alice, loopAsset, "1500000000000000000", "200"),
          // 250 × 0.9997 = 249.925
          balance(alice, communityAsset, "250000000000000000000", "200"),
          // 0.000000000000000001 × 720.78 = 0.00000000000000072078
          balance(bob, loopAsset, "1", "199"),
          // 0 × 0.9997 = 0
          balance(bob, communityAsset, "0", "199"),
        ],
        prices: [price(loopAsset, "720.78"), price(communityAsset, "0.9997")],
        communityWeights: [],
      },
      { configVersion: baseline.configVersion, document: baseline.formula },
    );
    expect(result.kind).toBe("computed");
    if (result.kind !== "computed") {
      return;
    }
    expect(result.formulaVersion).toBe(
      "miningFormula-devBaseline-2026-09-15-r2",
    );
    expect(
      result.powers.map((row) => [row.ownerUserId, row.assetId, row.power]),
    ).toEqual([
      [bob, loopAsset, "0.00000000000000072078"],
      [bob, communityAsset, "0"],
      [alice, loopAsset, "1081.17"],
      [alice, communityAsset, "249.925"],
    ]);
    // 1081.17 + 249.925 + 0.00000000000000072078 + 0
    expect(result.totalPower).toBe("1331.09500000000000072078");
    expect(result.skipped).toEqual([]);
  });

  it("uses a declared proxy price and carries it as proxied; refuses an undeclared or wrong proxy (Decision 0044)", () => {
    const declared = {
      configVersion: "miningFormulaTestOnly",
      document: {
        ...testOnlyFormula.document,
        assetWeights: { [nativeAsset]: "1", [loopAsset]: "1" },
        priceProxies: { [nativeAsset]: wbnbAsset },
      },
    };
    // 0.25 BNB × 720.78 (WBNB's own fresh price) × 1 = 180.195
    const result = computeMiningSnapshot(
      {
        balances: [
          balance(alice, nativeAsset, "250000000000000000"),
          balance(alice, loopAsset, "1000000000000000000"),
        ],
        prices: [
          price(
            nativeAsset,
            "720.78",
            "proxied",
            "2026-09-08T00:00:00.000Z",
            wbnbAsset,
          ),
          // LOOP priced through some other asset the version never declared
          price(
            loopAsset,
            "9",
            "proxied",
            "2026-09-08T00:00:00.000Z",
            communityAsset,
          ),
        ],
        communityWeights: [],
      },
      declared,
    );
    expect(result.kind).toBe("computed");
    if (result.kind !== "computed") {
      return;
    }
    expect(result.powers).toEqual([
      {
        ownerUserId: alice,
        assetId: nativeAsset,
        holding: "0.25",
        referencePriceUsd: "720.78",
        referencePriceQuality: "proxied",
        referencePriceProxyAssetId: wbnbAsset,
        weight: "1",
        power: "180.195",
        blockNumber: "100",
      },
    ]);
    expect(result.skipped).toEqual([
      { assetId: loopAsset, reasonCode: "MINING_PRICE_PROXY_NOT_DECLARED" },
    ]);
    // The same proxied price under a version that declares no proxy.
    const undeclared = computeMiningSnapshot(
      {
        balances: [balance(alice, nativeAsset, "250000000000000000")],
        prices: [
          price(
            nativeAsset,
            "720.78",
            "proxied",
            "2026-09-08T00:00:00.000Z",
            wbnbAsset,
          ),
        ],
        communityWeights: [],
      },
      {
        configVersion: "miningFormulaTestOnly",
        document: {
          ...testOnlyFormula.document,
          assetWeights: { [nativeAsset]: "1" },
        },
      },
    );
    expect(undeclared).toMatchObject({
      kind: "unavailable",
      reasonCode: "MINING_PRICE_PROXY_NOT_DECLARED",
    });
    // A stale proxy observation is stale on its own clock, declared or not.
    const stale = computeMiningSnapshot(
      {
        balances: [balance(alice, nativeAsset, "250000000000000000")],
        prices: [
          price(
            nativeAsset,
            "720.78",
            "stale",
            "2026-09-08T00:00:00.000Z",
            wbnbAsset,
          ),
        ],
        communityWeights: [],
      },
      declared,
    );
    expect(stale).toMatchObject({
      kind: "unavailable",
      reasonCode: "MINING_PRICE_NOT_FRESH",
    });
  });

  it("never uses a stale, undeclared-proxy, or missing price", () => {
    const stale = computeMiningSnapshot(
      {
        balances: [balance(alice, loopAsset, "1000000000000000000")],
        prices: [price(loopAsset, "0.25", "stale")],
        communityWeights: [],
      },
      testOnlyFormula,
    );
    expect(stale).toMatchObject({
      kind: "unavailable",
      reasonCode: "MINING_PRICE_NOT_FRESH",
    });
    const proxied = computeMiningSnapshot(
      {
        balances: [balance(alice, loopAsset, "1000000000000000000")],
        prices: [price(loopAsset, "0.25", "proxied")],
        communityWeights: [],
      },
      testOnlyFormula,
    );
    expect(proxied).toMatchObject({
      kind: "unavailable",
      reasonCode: "MINING_PRICE_PROXY_NOT_DECLARED",
    });
    const missing = computeMiningSnapshot(
      {
        balances: [balance(alice, loopAsset, "1000000000000000000")],
        prices: [],
        communityWeights: [],
      },
      testOnlyFormula,
    );
    expect(missing.kind).toBe("unavailable");
  });

  it("is unavailable with no balances and never produces a number for nothing", () => {
    expect(
      computeMiningSnapshot(
        { balances: [], prices: [], communityWeights: [] },
        testOnlyFormula,
      ),
    ).toEqual({
      kind: "unavailable",
      reasonCode: "MINING_NO_BALANCE_INPUTS",
      skipped: [],
    });
  });

  it("sums the holdings of several wallets of one account and keeps the newest block", () => {
    const result = computeMiningSnapshot(
      {
        balances: [
          balance(alice, loopAsset, "1000000000000000000", "10"),
          {
            ...balance(alice, loopAsset, "3000000000000000000", "12"),
            walletId: "0b2c1d3e-4f5a-4b6c-8d7e-9f0a1b2c3d4e",
          },
        ],
        prices: [price(loopAsset, "1.5")],
        communityWeights: [],
      },
      testOnlyFormula,
    );
    expect(result.kind).toBe("computed");
    if (result.kind !== "computed") {
      return;
    }
    expect(result.powers).toEqual([
      {
        ownerUserId: alice,
        assetId: loopAsset,
        holding: "4",
        referencePriceUsd: "1.5",
        referencePriceQuality: "fresh",
        referencePriceProxyAssetId: null,
        weight: "1",
        power: "6",
        blockNumber: "12",
      },
    ]);
  });
});
