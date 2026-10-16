import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { parseMemeConfig } from "../src/config.js";
import {
  MemeMetadataInvalidError,
  memeMetadataHash,
  parseMemeTokenMetadata,
} from "../src/features/meme/meme-contract.js";
import {
  MemeSellExceedsSoldError,
  ceilDiv,
  exceedsRelativeDifference,
  formatE18,
  freshMemeCurve,
  memeE18,
  memeGraduationUsd1Estimate,
  memeK,
  memeMarketCapRaw,
  memePriceE18,
  memePriceImpactBps,
  memeProgressBps,
  memeSaleSupply,
  memeV0,
  memeVTokenFull,
  memeWalletCap,
  quoteMemeBuy,
  quoteMemeSell,
  realUsd1Of,
  soldOf,
} from "../src/features/meme/meme-curve-math.js";
import { percentChange } from "../src/features/meme/meme-projection.js";

/**
 * Decision 0101 contract: the docs/10 §2 recomputation replays the
 * loop-contracts reference (`scripts/lib/meme-math.ts`, which the contract
 * suite proves equal to the chain's quoteBuy/quoteSell) step for step.
 */

interface FixtureStep {
  readonly side: "buy" | "sell";
  readonly vUsd1: string;
  readonly vToken: string;
  readonly amount: string;
  readonly out: string;
  readonly fee: string;
  readonly refund: string;
  readonly newVUsd1: string;
  readonly newVToken: string;
}

const fixture = JSON.parse(
  readFileSync(
    new URL("./fixtures/meme/curve-quotes.json", import.meta.url),
    "utf8",
  ),
) as { readonly steps: readonly FixtureStep[] };

describe("MEME curve recomputation (docs/10 §2)", () => {
  it("replays the contract reference fixture exactly", () => {
    expect(fixture.steps.length).toBeGreaterThan(100);
    for (const [index, step] of fixture.steps.entries()) {
      const curve = { vUsd1: BigInt(step.vUsd1), vToken: BigInt(step.vToken) };
      if (step.side === "buy") {
        const quote = quoteMemeBuy(curve, BigInt(step.amount));
        expect(
          {
            out: quote.tokensOut.toString(),
            fee: quote.fee.toString(),
            refund: quote.refund.toString(),
            newVUsd1: quote.newVUsd1.toString(),
            newVToken: quote.newVToken.toString(),
          },
          `step ${String(index)}`,
        ).toEqual({
          out: step.out,
          fee: step.fee,
          refund: step.refund,
          newVUsd1: step.newVUsd1,
          newVToken: step.newVToken,
        });
      } else {
        const quote = quoteMemeSell(curve, BigInt(step.amount));
        expect(
          {
            out: quote.usd1Out.toString(),
            fee: quote.fee.toString(),
            newVUsd1: quote.newVUsd1.toString(),
            newVToken: quote.newVToken.toString(),
          },
          `step ${String(index)}`,
        ).toEqual({
          out: step.out,
          fee: step.fee,
          newVUsd1: step.newVUsd1,
          newVToken: step.newVToken,
        });
      }
      // The invariant the contract keeps after every trade.
      expect(BigInt(step.newVUsd1)).toBe(
        ceilDiv(memeK, BigInt(step.newVToken)),
      );
    }
  });

  it("fills the curve with an exact refund and stops at 800M sold", () => {
    const last = fixture.steps.at(-1) as FixtureStep;
    const quote = quoteMemeBuy(
      { vUsd1: BigInt(last.vUsd1), vToken: BigInt(last.vToken) },
      BigInt(last.amount),
    );
    expect(quote.newVToken).toBe(memeVTokenFull);
    expect(quote.refund > 0n).toBe(true);
    expect(quote.paid + quote.refund).toBe(BigInt(last.amount));
    expect(soldOf({ vUsd1: quote.newVUsd1, vToken: quote.newVToken })).toBe(
      memeSaleSupply,
    );
    // docs/10 §1: about 17,582 USD1 raised, about 16,982 to the pool.
    expect(
      formatE18(realUsd1Of({ vUsd1: quote.newVUsd1, vToken: quote.newVToken })),
    ).toBe("17582.417582417582417583");
    expect(formatE18(memeGraduationUsd1Estimate)).toBe(
      "16982.417582417582417583",
    );
  });

  it("never lets a buy-then-sell round trip profit", () => {
    let curve = freshMemeCurve;
    for (const usd1 of [1n, 37n, 999n, 4_321n]) {
      const buy = quoteMemeBuy(curve, usd1 * memeE18);
      const after = { vUsd1: buy.newVUsd1, vToken: buy.newVToken };
      const sell = quoteMemeSell(after, buy.tokensOut);
      expect(sell.usd1Out < buy.paid).toBe(true);
      curve = after;
    }
    expect(() => quoteMemeSell(freshMemeCurve, 1n)).toThrow(
      MemeSellExceedsSoldError,
    );
  });

  it("derives price, market cap, progress, impact, and percent change", () => {
    expect(formatE18(memePriceE18(freshMemeCurve))).toBe(
      "0.000005591798695246",
    );
    expect(formatE18(memeMarketCapRaw(freshMemeCurve))).toBe(
      "5591.79869524697110904",
    );
    expect(memeProgressBps(0n)).toBe(0);
    expect(memeProgressBps(memeSaleSupply / 2n)).toBe(5_000);
    expect(memeProgressBps(memeSaleSupply)).toBe(10_000);
    const buy = quoteMemeBuy(freshMemeCurve, 1_000n * memeE18);
    expect(
      memePriceImpactBps(freshMemeCurve, {
        vUsd1: buy.newVUsd1,
        vToken: buy.newVToken,
      }),
    ).toBeGreaterThan(3_000);
    expect(percentChange(110n, 100n)).toBe("10.00");
    expect(percentChange(95n, 100n)).toBe("-5.00");
    expect(percentChange(1n, 0n)).toBeNull();
    expect(formatE18(-memeE18 / 2n)).toBe("-0.5");
    expect(memeWalletCap).toBe(40_000_000n * memeE18);
    expect(memeV0).toBe(6_000n * memeE18);
  });

  it("flags a recomputation drift above 0.1%", () => {
    expect(exceedsRelativeDifference(1_000n, 1_000n, 10n)).toBe(false);
    expect(exceedsRelativeDifference(1_000n, 999n, 10n)).toBe(false);
    expect(exceedsRelativeDifference(1_000n, 998n, 10n)).toBe(true);
  });
});

describe("MEME metadata and configuration (Decision 0101)", () => {
  const memeTokenId = "6d12a86e-4134-47e6-9312-c5ef75a30f55";

  it("validates name, symbol, description, image, and https links", () => {
    const metadata = parseMemeTokenMetadata({
      name: "  Frog Coin ",
      symbol: "FROG",
      description: "line\nbreak",
      links: { website: "https://frog.example/", twitter: "" },
    });
    expect(metadata).toEqual({
      name: "Frog Coin",
      symbol: "FROG",
      description: "line\nbreak",
      imageMediaId: null,
      links: {
        twitter: null,
        telegram: null,
        website: "https://frog.example/",
      },
    });
    for (const [body, field] of [
      [{ name: "", symbol: "FROG" }, "name"],
      [{ name: "x".repeat(33), symbol: "FROG" }, "name"],
      [{ name: "a\u0000b", symbol: "FROG" }, "name"],
      [{ name: "Frog", symbol: "frog" }, "symbol"],
      [{ name: "Frog", symbol: "F" }, "symbol"],
      [
        { name: "Frog", symbol: "FROG", description: "x".repeat(501) },
        "description",
      ],
      [{ name: "Frog", symbol: "FROG", imageMediaId: "nope" }, "imageMediaId"],
      [
        {
          name: "Frog",
          symbol: "FROG",
          links: { website: "http://a.example" },
        },
        "links.website",
      ],
      [
        { name: "Frog", symbol: "FROG", links: { other: "https://a.example" } },
        "links",
      ],
    ] as const) {
      expect(() => parseMemeTokenMetadata(body)).toThrow(
        MemeMetadataInvalidError,
      );
      try {
        parseMemeTokenMetadata(body);
      } catch (error) {
        expect((error as MemeMetadataInvalidError).field).toBe(field);
      }
    }
  });

  it("hashes the canonical metadata deterministically per token", () => {
    const metadata = parseMemeTokenMetadata({ name: "Frog", symbol: "FROG" });
    const hash = memeMetadataHash({ metadata, memeTokenId });
    expect(hash).toMatch(/^0x[0-9a-f]{64}$/);
    expect(memeMetadataHash({ metadata, memeTokenId })).toBe(hash);
    expect(
      memeMetadataHash({
        metadata,
        memeTokenId: "7d12a86e-4134-47e6-9312-c5ef75a30f55",
      }),
    ).not.toBe(hash);
  });

  it("keeps the contract null until all four keys and the Launch USD1 exist", () => {
    const base = {
      MEME_SALT_POOL_TARGET: 50,
      MEME_VANITY_SUFFIX: "6666",
      MEME_CREATE_DAILY_LIMIT: 3,
      MEME_CLASSIC_CREATE_ENABLED: false,
    };
    const keys = {
      MEME_CONTRACT_ADDRESS: "0xE108d45e3e9d7b8c9c02c5e10544ad811cb39b8a",
      MEME_CONTRACT_VERSION: "1.0.0",
      MEME_CONTRACT_START_BLOCK: "135600269",
      MEME_TOKEN_IMPLEMENTATION: "0xa87a54dc67e407e8b6d67e690abdfe02f979f4da",
    };
    const launch = {
      address: "0x2b26fc1300311476cc3032bcfbcfb6cb1d953396",
      version: "1.0.0",
      versionMajor: 1,
      startBlock: 1n,
      usd1Address: "0x17d554fd27345940e21d1d7328d038bd4049ce2b",
    };
    expect(parseMemeConfig(base, launch).unconfiguredReason).toBe(
      "MEME_CONTRACT_NOT_CONFIGURED",
    );
    // Decision 0151: the switch is carried through as-is.
    expect(parseMemeConfig(base, launch).classicCreateEnabled).toBe(false);
    expect(
      parseMemeConfig({ ...base, MEME_CLASSIC_CREATE_ENABLED: true }, launch)
        .classicCreateEnabled,
    ).toBe(true);
    expect(
      parseMemeConfig(
        { ...base, ...keys, MEME_TOKEN_IMPLEMENTATION: undefined },
        launch,
      ).contract,
    ).toBeNull();
    expect(parseMemeConfig({ ...base, ...keys }, null).unconfiguredReason).toBe(
      "MEME_USD1_NOT_CONFIGURED",
    );
    const configured = parseMemeConfig({ ...base, ...keys }, launch);
    expect(configured.contract).toEqual({
      address: "0xe108d45e3e9d7b8c9c02c5e10544ad811cb39b8a",
      version: "1.0.0",
      versionMajor: 1,
      startBlock: 135_600_269n,
      tokenImplementation: "0xa87a54dc67e407e8b6d67e690abdfe02f979f4da",
      usd1Address: launch.usd1Address,
    });
    expect(() =>
      parseMemeConfig(
        { ...base, ...keys, MEME_CONTRACT_ADDRESS: "0x1234" },
        launch,
      ),
    ).toThrow(/MEME_CONTRACT_ADDRESS/);
    expect(() =>
      parseMemeConfig(
        { ...base, ...keys, MEME_CONTRACT_VERSION: "v1" },
        launch,
      ),
    ).toThrow(/MEME_CONTRACT_VERSION/);
  });
});
