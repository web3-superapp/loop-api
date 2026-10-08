import { describe, expect, it } from "vitest";

import {
  defineIntelPromotions,
  intelPromotions,
  intelPromotionsResource,
  InvalidIntelPromotionError,
  isAllowedIntelDeeplink,
  type IntelPromotion,
} from "../src/features/market/intel-promotions.js";
import {
  compareMarketCategoryKeys,
  pageMarketCategoryRows,
  type MarketCategoryOrderKey,
} from "../src/features/market/market-category-order.js";
import {
  marketCategoryRules,
  marketMajorAssetIds,
} from "../src/features/market/market-contract.js";
import { v2PrimaryTabs } from "../src/features/meta/product-policy.js";
import { computeNetWorthChange24h } from "../src/features/wallet/net-worth-change.js";

/** Decision 0100 pure rules: promotions allow-list, list order, net-worth change, tabs. */

const communityId = "439cabe6-4c98-4f99-860f-192ad52403a1";

function promotion(overrides: Partial<IntelPromotion> = {}): IntelPromotion {
  return {
    id: "5b0f8a2e-6d1c-4e7a-9b3f-2c8d4e6f1a09",
    title: "Card",
    subtitle: "",
    imageUrl: null,
    deeplink: "/intel",
    startsAt: "2026-10-08T00:00:00.000Z",
    endsAt: "2026-11-01T00:00:00.000Z",
    order: 0,
    ...overrides,
  };
}

describe("intel promotions (Decision 0100)", () => {
  it("admits only the in-app routes", () => {
    for (const link of [
      "/intel",
      "/square",
      "/meme",
      `/community/profile?id=${communityId}`,
    ]) {
      expect(isAllowedIntelDeeplink(link), link).toBe(true);
    }
    for (const link of [
      "https://evil.example/intel",
      "http://localhost/intel",
      "//evil.example",
      "javascript:alert(1)",
      "loop://intel",
      "/wallet",
      "/intel/",
      "/intel?x=1",
      "/community/profile?id=not-a-uuid",
      `/community/profile?id=${communityId}&next=https://evil.example`,
      "/community/profile?id=439CABE6-4C98-4F99-860F-192AD52403A1",
      " /intel",
      "",
      null,
      42,
    ]) {
      expect(isAllowedIntelDeeplink(link), String(link)).toBe(false);
    }
  });

  it("refuses an entry with an external link, a bad window, or a duplicate id", () => {
    for (const entries of [
      [promotion({ deeplink: "https://evil.example" })],
      [promotion({ imageUrl: "http://cdn.example/a.png" })],
      [promotion({ endsAt: "2026-10-08T00:00:00.000Z" })],
      [promotion({ id: "not-an-id" })],
      [promotion({ order: -1 })],
      [promotion({ title: " " })],
      [promotion(), promotion()],
    ]) {
      expect(() => defineIntelPromotions(entries)).toThrow(
        InvalidIntelPromotionError,
      );
    }
    expect(
      defineIntelPromotions([
        promotion({ deeplink: `/community/profile?id=${communityId}` }),
      ]),
    ).toHaveLength(1);
  });

  it("ships the two placeholders and publishes only the cards in force, by order", () => {
    expect(intelPromotions.map((entry) => entry.deeplink)).toEqual([
      "/intel",
      "/square",
    ]);
    const entries = defineIntelPromotions([
      promotion({ id: "5b0f8a2e-6d1c-4e7a-9b3f-2c8d4e6f1a0a", order: 2 }),
      promotion({ id: "5b0f8a2e-6d1c-4e7a-9b3f-2c8d4e6f1a0b", order: 1 }),
      promotion({
        id: "5b0f8a2e-6d1c-4e7a-9b3f-2c8d4e6f1a0c",
        startsAt: "2026-12-01T00:00:00.000Z",
        endsAt: "2026-12-31T00:00:00.000Z",
      }),
    ]);
    const resource = intelPromotionsResource(
      new Date("2026-10-10T00:00:00.000Z"),
      entries,
    );
    expect(resource.items.map((item) => item.id)).toEqual([
      "5b0f8a2e-6d1c-4e7a-9b3f-2c8d4e6f1a0b",
      "5b0f8a2e-6d1c-4e7a-9b3f-2c8d4e6f1a0a",
    ]);
    expect(resource).toMatchObject({
      configVersion: "intelPromotionsV1",
      effectiveAt: "2026-10-08T00:00:00.000Z",
    });
    expect(
      intelPromotionsResource(new Date("2027-01-01T00:00:00.000Z")).items,
    ).toEqual([]);
  });
});

describe("categorised list order (Decision 0100)", () => {
  it("orders by value descending, unreported values last, assetId as the tie-breaker", () => {
    const rows: readonly MarketCategoryOrderKey[] = [
      { value: null, assetId: "eip155:56:0x02" },
      { value: "-3", assetId: "eip155:56:0x03" },
      { value: "10.5", assetId: "eip155:56:0x05" },
      { value: "10.5", assetId: "eip155:56:0x04" },
      { value: null, assetId: "eip155:56:0x01" },
      { value: "100", assetId: "eip155:56:0x06" },
    ];
    const ordered = [...rows].sort(compareMarketCategoryKeys);
    expect(ordered.map((row) => row.assetId)).toEqual([
      "eip155:56:0x06",
      "eip155:56:0x04",
      "eip155:56:0x05",
      "eip155:56:0x03",
      "eip155:56:0x01",
      "eip155:56:0x02",
    ]);
    // Walking the keyset visits every row once, whatever the page size.
    for (const pageSize of [1, 2, 4, 6]) {
      const seen: string[] = [];
      let after: MarketCategoryOrderKey | null = null;
      for (;;) {
        const page: {
          readonly items: readonly MarketCategoryOrderKey[];
          readonly hasMore: boolean;
        } = pageMarketCategoryRows(rows, (row) => row, after, pageSize);
        seen.push(...page.items.map((row) => row.assetId));
        if (!page.hasMore) {
          break;
        }
        after = page.items.at(-1) ?? null;
      }
      expect(seen, String(pageSize)).toEqual(ordered.map((row) => row.assetId));
    }
  });

  it("keeps the rule constants in range", () => {
    expect(marketCategoryRules.defaultLimit).toBe(30);
    expect(marketCategoryRules.maximumLimit).toBe(50);
    expect(new Set(marketMajorAssetIds).size).toBe(marketMajorAssetIds.length);
    expect(marketMajorAssetIds).toContain("eip155:56:native");
  });
});

describe("net worth 24h change (Decision 0100)", () => {
  it("sums v*p/(100+p) over the rows worth more than zero", () => {
    expect(
      computeNetWorthChange24h([
        { valueUsd: "105", change24hPct: "5" },
        { valueUsd: "80", change24hPct: "-20" },
        // A zero-value row without a 24h number does not block the total.
        { valueUsd: "0", change24hPct: null },
      ]),
    ).toEqual({
      status: "available",
      // +5 and -20 over earlier values 100 and 100.
      usd: "-15",
      pct: "-7.5",
    });
    expect(computeNetWorthChange24h([])).toEqual({
      status: "available",
      usd: "0",
      pct: "0",
    });
    expect(
      computeNetWorthChange24h([{ valueUsd: "1", change24hPct: "0" }]),
    ).toEqual({ status: "available", usd: "0", pct: "0" });
  });

  it("is unknown when one counted row lacks its number or has no earlier value", () => {
    for (const pct of [null, "-100", "-150"]) {
      expect(
        computeNetWorthChange24h([
          { valueUsd: "10", change24hPct: "1" },
          { valueUsd: "5", change24hPct: pct },
        ]),
      ).toEqual({ status: "unavailable", reasonCode: "PRICE_CHANGE_PARTIAL" });
    }
  });

  it("rounds the published numbers half away from zero", () => {
    expect(
      computeNetWorthChange24h([{ valueUsd: "10", change24hPct: "3" }]),
    ).toEqual({
      status: "available",
      // 10 * 3 / 103 = 0.29126213...; the percentage is exactly 3.
      usd: "0.291262",
      pct: "3",
    });
    expect(
      computeNetWorthChange24h([{ valueUsd: "10", change24hPct: "-3" }]),
    ).toEqual({
      status: "available",
      // 10 * -3 / 97 = -0.30927835...
      usd: "-0.309278",
      pct: "-3",
    });
  });
});

describe("v3 primary tabs (Decision 0100)", () => {
  it("is the five-tab navigation", () => {
    expect(v2PrimaryTabs).toEqual([
      "chat",
      "square",
      "meme",
      "intel",
      "wallet",
    ]);
  });
});
