import { describe, expect, it } from "vitest";

import { parseHooksLaunchDraft } from "../src/features/launch/hooks-launch-config.js";
import {
  InvalidLaunchRequestError,
  parseLaunchProjectValues,
} from "../src/features/launch/launch-contract.js";
import {
  normalizeLaunchTokenDescription,
  normalizeLaunchTokenName,
  utf8ByteLength,
} from "../src/features/launch/launch-token-text.js";

/** Decision 0154: no language or script rule on the token's text. */
describe("launch token text (Decision 0154)", () => {
  it("accepts Chinese, English, mixed and emoji names", () => {
    for (const name of [
      "币安人生",
      "Loop Doge",
      "狗狗 Doge 2026",
      "🐸 Pepe 青蛙",
      "👨‍👩‍👧 家族",
      "🏴󠁧󠁢󠁳󠁣󠁴󠁿 Scot",
      "Ünïcödé · ñame",
      "ミーム코인",
    ]) {
      expect(normalizeLaunchTokenName(name)).toBe(name);
    }
  });

  it("trims and NFC-normalises", () => {
    expect(normalizeLaunchTokenName("  éclair　")).toBe("éclair");
  });

  it("bounds the name by 64 characters and the factory's 64 UTF-8 bytes", () => {
    expect(normalizeLaunchTokenName("a".repeat(64))).toBe("a".repeat(64));
    expect(normalizeLaunchTokenName("a".repeat(65))).toBeNull();
    const chinese21 = "中".repeat(21);
    expect(utf8ByteLength(chinese21)).toBe(63);
    expect(normalizeLaunchTokenName(chinese21)).toBe(chinese21);
    expect(normalizeLaunchTokenName("中".repeat(22))).toBeNull();
    expect(normalizeLaunchTokenName("🐸".repeat(16))).toBe("🐸".repeat(16));
    expect(normalizeLaunchTokenName("🐸".repeat(17))).toBeNull();
  });

  it("refuses control, bidi-override and blank names", () => {
    for (const name of [
      "",
      "   ",
      "a\nb",
      "a\tb",
      "a\u0000b",
      "a\u007fb",
      "abc\u202egpj",
      "a\u2066b",
      "a\u200bb",
      "a\u2028b",
      "a\ud800b",
    ]) {
      expect(normalizeLaunchTokenName(name)).toBeNull();
    }
  });

  it("keeps line feeds and tabs in the description, folds CRLF", () => {
    expect(normalizeLaunchTokenDescription(" 第一行\r\n第二行\t🐸 ")).toBe(
      "第一行\n第二行\t🐸",
    );
    expect(normalizeLaunchTokenDescription("")).toBe("");
    expect(normalizeLaunchTokenDescription("a\u0007b")).toBeNull();
    expect(normalizeLaunchTokenDescription("a\u202eb")).toBeNull();
  });

  it("counts description characters, not UTF-16 units", () => {
    expect(normalizeLaunchTokenDescription("🐸".repeat(2_000))).toBe(
      "🐸".repeat(2_000),
    );
    expect(normalizeLaunchTokenDescription("中".repeat(2_001))).toBeNull();
  });

  it("applies to the catalogue project", () => {
    const values = parseLaunchProjectValues({
      name: " 狗狗 Doge 🐶 ",
      ticker: "DOGE",
      narrative: "中文简介\n第二行 🚀",
    });
    expect(values.name).toBe("狗狗 Doge 🐶");
    expect(values.narrative).toBe("中文简介\n第二行 🚀");
    expect(() =>
      parseLaunchProjectValues({
        name: "中".repeat(22),
        ticker: "DOGE",
        narrative: null,
      }),
    ).toThrow(InvalidLaunchRequestError);
  });

  it("keeps the ticker on the factories' on-chain pattern", () => {
    expect(() =>
      parseLaunchProjectValues({ name: "狗", ticker: "狗狗", narrative: null }),
    ).toThrow(InvalidLaunchRequestError);
  });

  it("applies to the Hooks draft that the factory signs", () => {
    const body = {
      name: " 币安人生 Life ",
      ticker: "life",
      logoAssetUrl: "https://example.com/logo.png",
      description: "中文\n🐸",
      links: [],
      nftSaleStartAt: "1900000000",
      buybackRecipient: "0x3333333333333333333333333333333333333333",
    };
    const policy = {
      nowUnixSeconds: "1800000000",
      minimumLeadSeconds: 86_400,
      nftSaleDurationSeconds: 3_600,
    };
    const draft = parseHooksLaunchDraft(body, policy);
    expect(draft.name).toBe("币安人生 Life");
    expect(draft.ticker).toBe("LIFE");
    expect(draft.description).toBe("中文\n🐸");
    expect(() =>
      parseHooksLaunchDraft({ ...body, name: "中".repeat(22) }, policy),
    ).toThrow();
    expect(() =>
      parseHooksLaunchDraft({ ...body, name: "a\u0001" }, policy),
    ).toThrow();
  });
});
