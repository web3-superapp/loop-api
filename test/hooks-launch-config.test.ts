import { describe, expect, it } from "vitest";

import { keccak256, toBytes } from "viem";

import {
  hooksLaunchFixedEconomics,
  hooksLaunchFixedEconomicsFor,
  parseHooksLaunchDraft,
} from "../src/features/launch/hooks-launch-config.js";

const draft = {
  name: "LOOP 项目示例",
  ticker: "MEME",
  logoAssetUrl: "https://cdn.example.com/logo.png",
  description: "Project description",
  links: ["https://example.com", "https://x.com/loop"],
  nftSaleStartAt: "1800000000",
  buybackRecipient: "0x1234567890123456789012345678901234567890",
};

const policy = {
  nowUnixSeconds: "1790000000",
  minimumLeadSeconds: 86_400,
  nftSaleDurationSeconds: 604_800,
};

describe("Hooks launch fixed template config", () => {
  it("canonicalizes project fields while binding immutable economics", () => {
    const parsed = parseHooksLaunchDraft(draft, policy);
    expect(parsed.templateVersion).toBe("hooks_launch_v1");
    expect(parsed.fixedEconomics).toEqual(hooksLaunchFixedEconomics);
    expect(parsed.ticker).toBe("MEME");
    expect(parsed.buybackRecipient).toBe(draft.buybackRecipient);
    expect(parsed.configHash).toMatch(/^0x[0-9a-f]{64}$/);
    expect(
      parseHooksLaunchDraft(
        { ...draft, links: [...draft.links].reverse() },
        policy,
      ).configHash,
    ).toBe(parsed.configHash);
  });

  it("rejects invalid address, unsafe link, or launch time without deployment lead", () => {
    expect(() =>
      parseHooksLaunchDraft(
        {
          ...draft,
          buybackRecipient: "0x0000000000000000000000000000000000000000",
        },
        policy,
      ),
    ).toThrow("Invalid Hooks launch draft");
    expect(() =>
      parseHooksLaunchDraft(
        { ...draft, links: ["javascript:alert(1)"] },
        policy,
      ),
    ).toThrow("Invalid Hooks launch draft");
    expect(() =>
      parseHooksLaunchDraft({ ...draft, nftSaleStartAt: "1790000001" }, policy),
    ).toThrow("Invalid Hooks launch draft");
  });

  it("does not accept economic overrides from a draft", () => {
    expect(() =>
      parseHooksLaunchDraft(
        { ...draft, curveBuyTaxBps: 0 } as typeof draft,
        policy,
      ),
    ).toThrow("Invalid Hooks launch draft");
    expect(
      parseHooksLaunchDraft(draft, policy).fixedEconomics.curveBuyTaxBps,
    ).toBe(1_000);
  });

  describe("Decision 0119: the sale period comes from the target Factory", () => {
    // Golden values computed with the pre-S141 code (integration/v2 8c4e038,
    // `nftSaleDurationSeconds: 604_800` constant) for this exact fixture.
    const preS141ConfigHash =
      "0x9b16d09ef2d8725d7061d4876d80cbad80054d771b1a483810f232f53b3ab948";
    const preS141EconomicsJson =
      '{"chainId":"56","memeTotalSupplyRaw":"1000000000000000000000000000","curveSaleSupplyRaw":"800000000000000000000000000","initialLiquiditySupplyRaw":"200000000000000000000000000","graduationReserveUsd1Raw":"133333332000000000000000","nftPriceUsd1Raw":"100000000000000000000","nftSaleDurationSeconds":604800,"earlyRoundDurationSeconds":3600,"perAddressLifetimeBuyCapRaw":"5000000000000000000000000","curveBuyTaxBps":1000,"curveSellTaxBps":1000,"officialPoolBuyTaxBps":200,"officialPoolSellTaxBps":200,"lpFee":2500,"tickSpacing":60,"buybackOrderUsd1Raw":"100000000000000000000","buybackMinIntervalSeconds":10}';

    it("keeps the mainnet (604,800 s) configHash and economics byte-for-byte", () => {
      const parsed = parseHooksLaunchDraft(draft, {
        ...policy,
        nftSaleDurationSeconds: 604_800,
      });
      expect(parsed.configHash).toBe(preS141ConfigHash);
      expect(JSON.stringify(parsed.fixedEconomics)).toBe(preS141EconomicsJson);
      expect(hooksLaunchFixedEconomicsFor(604_800)).toBe(
        hooksLaunchFixedEconomics,
      );
      expect(
        keccak256(
          toBytes(JSON.stringify(hooksLaunchFixedEconomicsFor(604_800))),
        ),
      ).toBe(keccak256(toBytes(preS141EconomicsJson)));
    });

    it("hashes a 1-hour Factory as a different template, changing only that field", () => {
      const parsed = parseHooksLaunchDraft(draft, {
        ...policy,
        nftSaleDurationSeconds: 3_600,
      });
      expect(parsed.fixedEconomics.nftSaleDurationSeconds).toBe(3_600);
      expect(parsed.configHash).toBe(
        "0x917f1b8f2f06055c7e46c61f850b4ab27aa282e9523c9d523ab4b927d414d266",
      );
      expect(parsed.configHash).not.toBe(preS141ConfigHash);
      expect(JSON.stringify(parsed.fixedEconomics)).toBe(
        preS141EconomicsJson.replace(
          '"nftSaleDurationSeconds":604800',
          '"nftSaleDurationSeconds":3600',
        ),
      );
    });

    it("refuses a sale period outside the contract bounds (3,600..604,800 s)", () => {
      for (const seconds of [0, 3_599, 604_801, 1.5, Number.NaN]) {
        expect(() =>
          parseHooksLaunchDraft(draft, {
            ...policy,
            nftSaleDurationSeconds: seconds,
          }),
        ).toThrow("Invalid Hooks launch draft");
      }
    });
  });
});
