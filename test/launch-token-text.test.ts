import { describe, expect, it } from "vitest";

import { parseHooksLaunchDraft } from "../src/features/launch/hooks-launch-config.js";
import {
  InvalidLaunchRequestError,
  parseLaunchProjectValues,
} from "../src/features/launch/launch-contract.js";
import {
  isOnChainLaunchTokenText,
  launchTokenTextRejectionReason,
  launchTokenTextVisibilityViolation,
  normalizeLaunchTokenDescription,
  normalizeLaunchTokenName,
  normalizeLaunchTokenText,
  normalizeLaunchTokenTicker,
  utf8ByteLength,
} from "../src/features/launch/launch-token-text.js";
import {
  MemeMetadataInvalidError,
  parseMemeTokenMetadata,
} from "../src/features/meme/meme-contract.js";

/**
 * Decision 0154: no language or script rule on the token's text.
 * Decision 0164: name and ticker share the four.meme rule — NFC + trim,
 * 1–20 UTF-16 units, never upper-cased.
 */
describe("launch token text (Decisions 0154 / 0164)", () => {
  it("uses one function for name and ticker", () => {
    expect(normalizeLaunchTokenName).toBe(normalizeLaunchTokenText);
    expect(normalizeLaunchTokenTicker).toBe(normalizeLaunchTokenText);
  });

  it("accepts Chinese, English, mixed, kana, Hangul and emoji", () => {
    for (const text of [
      "币安人生",
      "Loop Doge",
      "狗狗 Doge 2026",
      "🐸 Pepe 青蛙",
      "👨\u200d👩\u200d👧 家族",
      "🏴󠁧󠁢󠁳󠁣󠁴󠁿 Scot",
      "Ünïcödé · ñame",
      "ミーム코인",
      "四",
      "$1",
      "doge",
      "1inch",
      "フリーダム.オブ.マネー",
      "币安\u3000人生",
    ]) {
      expect(normalizeLaunchTokenText(text)).toBe(text);
    }
  });

  it("never upper-cases", () => {
    expect(normalizeLaunchTokenTicker("doge")).toBe("doge");
    expect(normalizeLaunchTokenTicker("straße")).toBe("straße");
  });

  it("trims and NFC-normalises", () => {
    expect(normalizeLaunchTokenText("  éclair\u3000")).toBe("éclair");
    expect(normalizeLaunchTokenText(" DOGE ")).toBe("DOGE");
  });

  it("bounds by 20 UTF-16 units (JavaScript length, as four.meme)", () => {
    expect(normalizeLaunchTokenText("a".repeat(20))).toBe("a".repeat(20));
    expect(normalizeLaunchTokenText("a".repeat(21))).toBeNull();
    expect(normalizeLaunchTokenText("中".repeat(20))).toBe("中".repeat(20));
    expect(normalizeLaunchTokenText("中".repeat(21))).toBeNull();
    // An emoji outside the BMP is two units: 10 fit, 11 do not.
    expect(normalizeLaunchTokenText("🐸".repeat(10))).toBe("🐸".repeat(10));
    expect(normalizeLaunchTokenText("🐸".repeat(11))).toBeNull();
    expect(normalizeLaunchTokenText("狗".repeat(19) + "🐸")).toBeNull();
    // Trimming happens before counting.
    expect(normalizeLaunchTokenText(`  ${"a".repeat(20)}  `)).toBe(
      "a".repeat(20),
    );
  });

  it("stays inside the factory's 80-byte floor at 20 units", () => {
    expect(utf8ByteLength("中".repeat(20))).toBe(60);
    expect(utf8ByteLength("🐸".repeat(10))).toBe(40);
    expect(isOnChainLaunchTokenText("a".repeat(80))).toBe(true);
    expect(isOnChainLaunchTokenText("a".repeat(81))).toBe(false);
  });

  it("refuses control, format, separator, filler and blank text", () => {
    for (const text of [
      "",
      "   ",
      "\u3000",
      "a\nb",
      "a\tb",
      "a\u0000b",
      "a\u007fb",
      "a\u0085b",
      "abc\u202egpj",
      "a\u2066b",
      "a\u200bb",
      "a\u200cb",
      "a\u2028b",
      "a\u2029b",
      "a\u2065b",
      "a\ud800b",
      "a\u00a0b",
      "a\u2003b",
      "a\u202fb",
      "a\u00adb",
      "a\u034fb",
      "a\u180eb",
      "a\u3164b",
      "a\u2800b",
      "a\ufeffb",
      "a\ufdd0b",
      "a\uffffb",
      "\u200d",
      "\u200da",
      "a\u200d",
    ]) {
      expect(normalizeLaunchTokenText(text)).toBeNull();
    }
  });

  it("checks stored / signed text without trimming or the 20-unit length", () => {
    expect(isOnChainLaunchTokenText("币安人生 Life")).toBe(true);
    expect(isOnChainLaunchTokenText("a".repeat(64))).toBe(true);
    expect(isOnChainLaunchTokenText(" DOGE")).toBe(false);
    expect(isOnChainLaunchTokenText("DOGE ")).toBe(false);
    expect(isOnChainLaunchTokenText("é")).toBe(false);
    expect(isOnChainLaunchTokenText("")).toBe(false);
    expect(isOnChainLaunchTokenText(1)).toBe(false);
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

  it("applies to the catalogue project, ticker included", () => {
    const values = parseLaunchProjectValues({
      name: " 狗狗 Doge 🐶 ",
      ticker: " 狗狗币 ",
      narrative: "中文简介\n第二行 🚀",
    });
    expect(values.name).toBe("狗狗 Doge 🐶");
    expect(values.ticker).toBe("狗狗币");
    expect(values.narrative).toBe("中文简介\n第二行 🚀");
    expect(
      parseLaunchProjectValues({ name: "四", ticker: "$1", narrative: null })
        .ticker,
    ).toBe("$1");
    for (const bad of [
      { name: "中".repeat(21), ticker: "DOGE" },
      { name: "狗", ticker: "a".repeat(21) },
      { name: "狗", ticker: "a\u202eb" },
      { name: "狗", ticker: "" },
    ]) {
      expect(() =>
        parseLaunchProjectValues({ ...bad, narrative: null }),
      ).toThrow(InvalidLaunchRequestError);
    }
  });

  it("applies to the Hooks draft that the factory signs, keeping case", () => {
    const body = {
      name: " 币安人生 Life ",
      ticker: " life ",
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
    expect(draft.ticker).toBe("life");
    expect(draft.description).toBe("中文\n🐸");
    expect(
      parseHooksLaunchDraft(
        { ...body, ticker: "フリーダム.オブ.マネー" },
        policy,
      ).ticker,
    ).toBe("フリーダム.オブ.マネー");
    // Case is part of the signed bytes, so it changes the config hash.
    expect(
      parseHooksLaunchDraft({ ...body, ticker: "LIFE" }, policy).configHash,
    ).not.toBe(draft.configHash);
    for (const patch of [
      { name: "中".repeat(21) },
      { name: "a\u0001" },
      { ticker: "a".repeat(21) },
      { ticker: "\u200dA" },
      { ticker: "  " },
    ]) {
      expect(() =>
        parseHooksLaunchDraft({ ...body, ...patch }, policy),
      ).toThrow();
    }
  });

  it("applies to MEME create (name and symbol)", () => {
    const parsed = parseMemeTokenMetadata({ name: " 青蛙 ", symbol: " 🐸蛙 " });
    expect(parsed.name).toBe("青蛙");
    expect(parsed.symbol).toBe("🐸蛙");
    expect(
      parseMemeTokenMetadata({ name: "Pepe", symbol: "pepe" }).symbol,
    ).toBe("pepe");
    expect(() =>
      parseMemeTokenMetadata({ name: "Pepe", symbol: "a".repeat(21) }),
    ).toThrow(MemeMetadataInvalidError);
    expect(() =>
      parseMemeTokenMetadata({ name: "a".repeat(21), symbol: "PEPE" }),
    ).toThrow(MemeMetadataInvalidError);
  });
});

/**
 * Decision 0168 (S255 audit L-6): a name / ticker must be visibly something.
 * ① at least one `[\p{L}\p{N}\p{S}\p{P}]`; ② tag characters only inside a
 * 🏴 … U+E007F flag; ③ no leading combining mark.
 */
describe("launch token text visibility (Decision 0168)", () => {
  const england =
    "\u{1f3f4}\u{e0067}\u{e0062}\u{e0065}\u{e006e}\u{e0067}\u{e007f}";

  it.each([
    ["U+E0041 (a lone tag)", "\u{e0041}", "TEXT_NOT_VISIBLE"],
    ["two tags", "\u{e0041}\u{e0042}", "TEXT_NOT_VISIBLE"],
    ["U+FE0F", "\ufe0f", "TEXT_NOT_VISIBLE"],
    ["U+FE00", "\ufe00", "TEXT_NOT_VISIBLE"],
    ["U+E0100", "\u{e0100}", "TEXT_NOT_VISIBLE"],
    ["U+0301 alone", "\u0301", "TEXT_NOT_VISIBLE"],
    ["a cancel tag alone", "\u{e007f}", "TEXT_NOT_VISIBLE"],
    ["a tag after a letter", "A\u{e0041}", "TAG_OUTSIDE_FLAG"],
    ["a tag after an emoji", "\u{1f600}\u{e0041}", "TAG_OUTSIDE_FLAG"],
    ["an unterminated flag", "\u{1f3f4}\u{e0067}\u{e0062}", "TAG_OUTSIDE_FLAG"],
    ["a flag with no tag body", "\u{1f3f4}\u{e007f}", "TAG_OUTSIDE_FLAG"],
    ["a tag after a complete flag", `${england}\u{e0041}`, "TAG_OUTSIDE_FLAG"],
    ["a combining acute first", "\u0301abc", "LEADING_COMBINING_MARK"],
    ["a variation selector first", "\ufe0fA", "LEADING_COMBINING_MARK"],
    ["U+E0100 first", "\u{e0100}币", "LEADING_COMBINING_MARK"],
  ] as const)("refuses %s with %s", (_label, text, reason) => {
    expect(normalizeLaunchTokenText(text)).toBeNull();
    expect(isOnChainLaunchTokenText(text)).toBe(false);
    expect(launchTokenTextVisibilityViolation(text)).toBe(reason);
    expect(launchTokenTextRejectionReason(text)).toBe(reason);
    // Surrounding spaces are trimmed first.
    expect(launchTokenTextRejectionReason(` ${text} `)).toBe(reason);
  });

  it.each([
    ["the England flag", england],
    ["the England flag with text", `${england} ENG`],
    ["the Scotland flag", "🏴󠁧󠁢󠁳󠁣󠁴󠁿"],
    ["a plain black flag", "\u{1f3f4}"],
    ["Chinese", "币安人生"],
    ["an emoji", "🐸"],
    ["an emoji with VS16", "\u2764\ufe0f"],
    ["a ZWJ family", "👨\u200d👩\u200d👧"],
    ["a dollar sign", "$"],
    ["punctuation", "."],
    ["a digit", "1"],
    ["a decomposed é (NFC composes it)", "e\u0301"],
    ["a mark after a letter", "a\u0301\u0302"],
  ] as const)("accepts %s", (_label, text) => {
    const normalized = normalizeLaunchTokenText(text);
    expect(normalized).toBe(text.normalize("NFC"));
    expect(launchTokenTextVisibilityViolation(normalized ?? "")).toBeNull();
    expect(isOnChainLaunchTokenText(normalized)).toBe(true);
  });

  it("reports no visibility reason for text another rule refuses", () => {
    expect(launchTokenTextRejectionReason("a".repeat(21))).toBeNull();
    expect(launchTokenTextRejectionReason("\u{e0041}".repeat(11))).toBeNull();
    expect(launchTokenTextRejectionReason("a\u202eb")).toBeNull();
    expect(launchTokenTextRejectionReason("")).toBeNull();
    expect(launchTokenTextRejectionReason("DOGE")).toBeNull();
    expect(launchTokenTextRejectionReason(1)).toBeNull();
  });

  it("names the field and reason on the catalogue project", () => {
    expect(() =>
      parseLaunchProjectValues({
        name: "狗",
        ticker: "\u{e0041}",
        narrative: null,
      }),
    ).toThrow(
      expect.objectContaining({
        textRejection: { reasonCode: "TEXT_NOT_VISIBLE", field: "ticker" },
      }),
    );
    expect(() =>
      parseLaunchProjectValues({
        name: "\u0301abc",
        ticker: "DOGE",
        narrative: null,
      }),
    ).toThrow(
      expect.objectContaining({
        textRejection: { reasonCode: "LEADING_COMBINING_MARK", field: "name" },
      }),
    );
    expect(() =>
      parseLaunchProjectValues({
        name: "中".repeat(21),
        ticker: "DOGE",
        narrative: null,
      }),
    ).toThrow(expect.objectContaining({ textRejection: null }));
  });

  it("names the field and reason on the Hooks draft", () => {
    const body = {
      name: "Loop",
      ticker: "LOOP",
      logoAssetUrl: "https://example.com/logo.png",
      description: "",
      links: [],
      nftSaleStartAt: "1900000000",
      buybackRecipient: "0x3333333333333333333333333333333333333333",
    };
    const policy = {
      nowUnixSeconds: "1800000000",
      minimumLeadSeconds: 86_400,
      nftSaleDurationSeconds: 3_600,
    };
    expect(() =>
      parseHooksLaunchDraft({ ...body, name: "\ufe0f" }, policy),
    ).toThrow(
      expect.objectContaining({
        textRejection: { reasonCode: "TEXT_NOT_VISIBLE", field: "name" },
      }),
    );
    expect(() =>
      parseHooksLaunchDraft({ ...body, ticker: "A\u{e0041}" }, policy),
    ).toThrow(
      expect.objectContaining({
        textRejection: { reasonCode: "TAG_OUTSIDE_FLAG", field: "ticker" },
      }),
    );
    expect(
      parseHooksLaunchDraft({ ...body, ticker: england }, policy).ticker,
    ).toBe(england);
  });

  it("adds textReasonCode on MEME create, keeping the field", () => {
    expect(() =>
      parseMemeTokenMetadata({ name: "\u{e0100}", symbol: "PEPE" }),
    ).toThrow(
      expect.objectContaining({
        field: "name",
        textReasonCode: "TEXT_NOT_VISIBLE",
      }),
    );
    expect(() =>
      parseMemeTokenMetadata({ name: "Pepe", symbol: "\u0301abc" }),
    ).toThrow(
      expect.objectContaining({
        field: "symbol",
        textReasonCode: "LEADING_COMBINING_MARK",
      }),
    );
    expect(() =>
      parseMemeTokenMetadata({ name: "Pepe", symbol: "a".repeat(21) }),
    ).toThrow(
      expect.objectContaining({ field: "symbol", textReasonCode: null }),
    );
  });
});
