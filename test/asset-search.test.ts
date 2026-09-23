import { describe, expect, it } from "vitest";

import type { AssetRecord } from "../src/database/chain-registry-repository.js";
import {
  assetSearchMatchKinds,
  compareAssetSearchMatches,
  InvalidAssetSearchQueryError,
  matchRegistryAsset,
  parseAssetSearchQuery,
  searchRegistryAssets,
} from "../src/features/community/asset-search.js";

function asset(input: {
  readonly assetId: string;
  readonly address: string | null;
  readonly symbol: string;
  readonly name: string;
}): AssetRecord {
  return Object.freeze({
    assetId: input.assetId,
    chainId: "eip155:56",
    address: input.address,
    symbol: input.symbol,
    name: input.name,
    decimals: 18,
    status: "pending",
    sourceKind: input.address === null ? "chain_native" : "chain_call",
    sourceBlockNumber: "1",
    sourceVerifiedAt: null,
    updatedAt: "2026-09-23T00:00:00.000Z",
  });
}

const bnb = asset({
  assetId: "eip155:56:native",
  address: null,
  symbol: "BNB",
  name: "BNB",
});
const wbnb = asset({
  assetId: "eip155:56:0xbb4cdb9cbd36b01bd1cbaebf2de08d9173bc095c",
  address: "0xbb4cdb9cbd36b01bd1cbaebf2de08d9173bc095c",
  symbol: "WBNB",
  name: "Wrapped BNB",
});
const usdt = asset({
  assetId: "eip155:56:0x55d398326f99059ff775485246999027b3197955",
  address: "0x55d398326f99059ff775485246999027b3197955",
  symbol: "USDT",
  name: "Tether USD",
});
const cake = asset({
  assetId: "eip155:56:0x0e09fabb73bd3ade0a17ecc321fd13a19e81ce82",
  address: "0x0e09fabb73bd3ade0a17ecc321fd13a19e81ce82",
  symbol: "Cake",
  name: "PancakeSwap Token",
});
const registry = [cake, usdt, wbnb, bnb];

describe("asset search query (Decision 0071)", () => {
  it("normalizes, folds whitespace, and lower-cases the literal query", () => {
    expect(parseAssetSearchQuery("  Tether   USD ")).toBe("tether usd");
    expect(parseAssetSearchQuery("ＵＳＤＴ")).toBe("usdt");
    expect(parseAssetSearchQuery("0x55D398")).toBe("0x55d398");
  });

  it("refuses a non-string, a single code point, more than 64, and control characters", () => {
    for (const value of [
      undefined,
      42,
      "u",
      " u ",
      "a".repeat(65),
      "us\u0000dt",
      "us​dt",
    ]) {
      expect(() => parseAssetSearchQuery(value)).toThrow(
        InvalidAssetSearchQueryError,
      );
    }
    expect(parseAssetSearchQuery("a".repeat(64))).toHaveLength(64);
  });
});

describe("asset search matching", () => {
  it("ranks an exact symbol above a symbol prefix, a name prefix, a name word, and an address", () => {
    expect(matchRegistryAsset(bnb, "bnb")?.rank).toBe(
      assetSearchMatchKinds.symbolExact,
    );
    expect(matchRegistryAsset(usdt, "us")?.rank).toBe(
      assetSearchMatchKinds.symbolPrefix,
    );
    expect(matchRegistryAsset(usdt, "tether")?.rank).toBe(
      assetSearchMatchKinds.namePrefix,
    );
    expect(matchRegistryAsset(wbnb, "bnb")?.rank).toBe(
      assetSearchMatchKinds.nameWordPrefix,
    );
    expect(matchRegistryAsset(usdt, "0x55d3")?.rank).toBe(
      assetSearchMatchKinds.addressPrefix,
    );
  });

  it("matches the address with or without 0x, but bare hex only from four digits", () => {
    expect(matchRegistryAsset(usdt, "55d3")?.rank).toBe(
      assetSearchMatchKinds.addressPrefix,
    );
    expect(matchRegistryAsset(usdt, "55d")).toBeNull();
    expect(matchRegistryAsset(usdt, "0x55")?.rank).toBe(
      assetSearchMatchKinds.addressPrefix,
    );
    expect(matchRegistryAsset(usdt, "0x56")).toBeNull();
    // A native asset has no address to match.
    expect(matchRegistryAsset(bnb, "0x00")).toBeNull();
  });

  it("is case-insensitive on symbol and name and never a substring match", () => {
    expect(matchRegistryAsset(cake, "cake")?.rank).toBe(
      assetSearchMatchKinds.symbolExact,
    );
    expect(matchRegistryAsset(cake, "pancake")?.rank).toBe(
      assetSearchMatchKinds.namePrefix,
    );
    expect(matchRegistryAsset(cake, "swap")).toBeNull();
    expect(matchRegistryAsset(cake, "ake")).toBeNull();
  });

  it("orders by rank, then symbol, then asset ID", () => {
    const ordered = registry
      .map((row) => matchRegistryAsset(row, "bnb"))
      .filter((match) => match !== null)
      .sort(compareAssetSearchMatches)
      .map((match) => match.asset.symbol);
    expect(ordered).toEqual(["BNB", "WBNB"]);
    const twins = [
      { asset: { ...usdt, assetId: "eip155:56:0xb" }, rank: 1 as const },
      { asset: { ...usdt, assetId: "eip155:56:0xa" }, rank: 1 as const },
    ];
    expect(
      [...twins].sort(compareAssetSearchMatches).map((m) => m.asset.assetId),
    ).toEqual(["eip155:56:0xa", "eip155:56:0xb"]);
  });
});

describe("asset search paging", () => {
  it("pages in the total order and continues after the last asset ID", () => {
    const first = searchRegistryAssets(registry, "bnb", {
      limit: 1,
      afterAssetId: null,
    });
    expect(first.items.map((m) => m.asset.symbol)).toEqual(["BNB"]);
    expect(first.hasMore).toBe(true);
    const second = searchRegistryAssets(registry, "bnb", {
      limit: 1,
      afterAssetId: "eip155:56:native",
    });
    expect(second.items.map((m) => m.asset.symbol)).toEqual(["WBNB"]);
    expect(second.hasMore).toBe(false);
  });

  it("starts from the top when the continuation row is no longer in the result", () => {
    const page = searchRegistryAssets(registry, "bnb", {
      limit: 5,
      afterAssetId: "eip155:56:0x0000000000000000000000000000000000000000",
    });
    expect(page.items.map((m) => m.asset.symbol)).toEqual(["BNB", "WBNB"]);
    expect(page.hasMore).toBe(false);
  });

  it("answers an empty page, not an error, for a query nothing matches", () => {
    expect(
      searchRegistryAssets(registry, "zzz", { limit: 20, afterAssetId: null }),
    ).toEqual({ items: [], hasMore: false });
  });
});
