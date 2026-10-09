import { describe, expect, it } from "vitest";

import {
  hooksLaunchFixedEconomics,
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

const policy = { nowUnixSeconds: "1790000000", minimumLeadSeconds: 86_400 };

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
});
