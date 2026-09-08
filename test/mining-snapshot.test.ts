import { describe, expect, it } from "vitest";

import type { MiningFormulaDocument } from "../src/features/mining/mining-contract.js";
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
): MiningPriceInput {
  return { assetId, priceUsd, quality, fetchedAt, source: "dexscreener" };
}

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
        weight: "1",
        power: "0.125",
        blockNumber: "118",
      },
      {
        ownerUserId: alice,
        assetId: loopAsset,
        holding: "2",
        referencePriceUsd: "0.25",
        weight: "1",
        power: "0.5",
        blockNumber: "120",
      },
    ]);
    expect(result.totalPower).toBe("0.625");
    expect(result.skipped).toEqual([]);
  });

  it("uses an approved community weight and skips pending or unweighted assets", () => {
    const result = computeMiningSnapshot(
      {
        balances: [
          balance(alice, communityAsset, "10000000000000000000"),
          balance(alice, unweightedAsset, "10000000000000000000"),
        ],
        prices: [price(communityAsset, "2"), price(unweightedAsset, "99")],
        communityWeights: [
          {
            communityId: "3fa85f64-5717-4562-b3fc-2c963f66afa6",
            assetId: communityAsset,
            weight: "0.35",
            status: "approved",
          },
          {
            communityId: "9c1f0f2e-5a7b-4c3d-8e9f-0a1b2c3d4e5f",
            assetId: unweightedAsset,
            weight: null,
            status: "pending_review",
          },
        ],
      },
      testOnlyFormula,
    );
    expect(result.kind).toBe("computed");
    if (result.kind !== "computed") {
      return;
    }
    expect(result.powers).toHaveLength(1);
    expect(result.powers[0]?.power).toBe("7");
    expect(result.skipped).toEqual([
      {
        assetId: unweightedAsset,
        reasonCode: "COMMUNITY_WEIGHT_PENDING_REVIEW",
      },
    ]);
  });

  it("never uses a stale, proxied, or missing price", () => {
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
    expect(proxied.kind).toBe("unavailable");
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
        weight: "1",
        power: "6",
        blockNumber: "12",
      },
    ]);
  });
});
