import { describe, expect, it } from "vitest";

import { parseHooksLaunchDraft } from "../src/features/launch/hooks-launch-config.js";
import {
  InvalidLaunchRequestError,
  parseLaunchProjectValues,
} from "../src/features/launch/launch-contract.js";
import {
  isOnChainLaunchTokenText,
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
      "👨‍👩‍👧 家族",
      "🏴󠁧󠁢󠁳󠁣󠁴󠁿 Scot",
      "Ünïcödé · ñame",
      "ミーム코인",
      "四",
      "$1",
      "doge",
      "1inch",
      "フリーダム.オブ.マネー",
      "币安　人生",
    ]) {
      expect(normalizeLaunchTokenText(text)).toBe(text);
    }
  });

  it("never upper-cases", () => {
    expect(normalizeLaunchTokenTicker("doge")).toBe("doge");
    expect(normalizeLaunchTokenTicker("straße")).toBe("straße");
  });

  it("trims and NFC-normalises", () => {
    expect(normalizeLaunchTokenText("  éclair　")).toBe("éclair");
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
      "　",
      "a\nb",
      "a\tb",
      "a\u0000b",
      "a\u007fb",
      "a\u0085b",
      "abc‮gpj",
      "a⁦b",
      "a​b",
      "a‌b",
      "a b",
      "a b",
      "a\ud800b",
      "a b",
      "a b",
      "a b",
      "a­b",
      "a͏b",
      "a᠎b",
      "aㅤb",
      "a⠀b",
      "a﻿b",
      "a﷐b",
      "a￿b",
      "‍",
      "‍a",
      "a‍",
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
    expect(normalizeLaunchTokenDescription("a‮b")).toBeNull();
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
      { name: "狗", ticker: "a‮b" },
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
      { ticker: "‍A" },
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
