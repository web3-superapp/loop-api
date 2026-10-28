import { describe, expect, it } from "vitest";

import {
  addDecimalStrings,
  compareDecimalStrings,
} from "../src/features/market/market-contract.js";
import { splitMiningSnapshotPower } from "../src/features/mining/mining-pool-split.js";

describe("Decision 0192 snapshot pool split", () => {
  function expectSums(
    power: string,
    split: { assetPower: string; nftPower: string } | null,
  ) {
    expect(split).not.toBeNull();
    if (split === null) return;
    expect(
      compareDecimalStrings(
        addDecimalStrings(split.assetPower, split.nftPower),
        power,
      ),
    ).toBe(0);
  }

  it("token-only: every row nftPower 0, the whole power is asset power", () => {
    const split = splitMiningSnapshotPower("1000", [
      { power: "115", nftPower: "0" },
      { power: "885", nftPower: "0" },
    ]);
    expect(split).toEqual({ assetPower: "1000", nftPower: "0" });
    expectSums("1000", split);
  });

  it("NFT-only: a MEME row whose power is all NFT", () => {
    const split = splitMiningSnapshotPower("3", [
      { power: "3", nftPower: "3" },
    ]);
    expect(split).toEqual({ assetPower: "0", nftPower: "3" });
    expectSums("3", split);
  });

  it("both: exact decimal arithmetic, 18-place fractions included", () => {
    const rows = [
      { power: "12.500000000000000001", nftPower: "2" },
      { power: "0.1", nftPower: "0.000000000000000001" },
      { power: "7", nftPower: "0" },
    ];
    const split = splitMiningSnapshotPower("19.600000000000000001", rows);
    expect(split).toEqual({
      assetPower: "17.6",
      nftPower: "2.000000000000000001",
    });
    expectSums("19.600000000000000001", split);
  });

  it("accepts the total as PostgreSQL numeric text (trailing zeros)", () => {
    const split = splitMiningSnapshotPower("4.0", [
      { power: "1.5", nftPower: "1" },
      { power: "2.5", nftPower: "0" },
    ]);
    expect(split).toEqual({ assetPower: "3", nftPower: "1" });
    expectSums("4.0", split);
  });

  it("an account with no row splits zero into zero and zero", () => {
    expect(splitMiningSnapshotPower("0", [])).toEqual({
      assetPower: "0",
      nftPower: "0",
    });
  });

  it("legacy snapshot: any row without nftPower publishes no split", () => {
    expect(
      splitMiningSnapshotPower("1000", [
        { power: "115", nftPower: "15" },
        { power: "885" },
      ]),
    ).toBeNull();
    expect(
      splitMiningSnapshotPower("1000", [{ power: "1000", nftPower: null }]),
    ).toBeNull();
  });

  it("never guesses: rows that do not add up to power, or NFT above power, give no split", () => {
    expect(
      splitMiningSnapshotPower("1001", [{ power: "1000", nftPower: "1" }]),
    ).toBeNull();
    expect(
      splitMiningSnapshotPower("1", [{ power: "1", nftPower: "2" }]),
    ).toBeNull();
  });
});
