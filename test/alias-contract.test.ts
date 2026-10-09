import { describe, expect, it } from "vitest";

import {
  aliasSearchPrefixKey,
  parseAliasSearchLimit,
  parseAliasSearchPrefix,
  parseCommunicationGroupId,
  parseGroupAlias,
  parseMemberSearchPrefix,
  parseStreamChannelId,
} from "../src/features/identity/alias-contract.js";

describe("alias discovery contract", () => {
  it("accepts bounded literal prefixes and immutable group display aliases", () => {
    expect(parseAliasSearchPrefix("  张三  ")).toBe("张三");
    expect(parseAliasSearchPrefix("%_")).toBe("%_");
    expect(parseAliasSearchPrefix("  ﬀ  ")).toBe("ﬀ");
    expect(parseAliasSearchPrefix("Ａ  Ｂ")).toBe("Ａ  Ｂ");
    expect(parseAliasSearchPrefix("A\u1680B")).toBe("A\u1680B");
    expect(parseAliasSearchPrefix("  ¨sam  ")).toBe("¨sam");
    expect(parseAliasSearchLimit(undefined)).toBe(20);
    expect(parseAliasSearchLimit(7)).toBe(7);
    expect(parseGroupAlias("  Group Persona  ")).toBe("Group Persona");
  });

  it.each([
    ["one code point", "张"],
    ["one code point after NFKC", "e\u0301"],
    ["empty", "  "],
    ["control", "ab\n"],
    ["bidi", "ab\u202e"],
    ["zero width", "ab\u200b"],
    ["soft hyphen", "ab\u00ad"],
    ["deprecated bidi format control", "ab\u206a"],
    ["too long", "😀".repeat(41)],
  ])("rejects unsafe search prefix: %s", (_label, value) => {
    expect(() => parseAliasSearchPrefix(value)).toThrow();
  });

  it("accepts a one code point community member prefix", () => {
    expect(parseMemberSearchPrefix("f")).toBe("f");
    expect(parseMemberSearchPrefix("  张  ")).toBe("张");
    expect(parseMemberSearchPrefix("e\u0301")).toBe("e\u0301");
    expect(parseMemberSearchPrefix("%_")).toBe("%_");
    expect(parseMemberSearchPrefix("  frog  maxi  ")).toBe("frog  maxi");
  });

  it.each([
    ["empty", ""],
    ["whitespace only", "   "],
    ["control", "fr\u0000og"],
    ["zero width", "fr\u200bog"],
    ["line separator", "fr\u2028og"],
    ["surrogate half", "fr\ud800og"],
    ["too long", "a".repeat(41)],
  ])("rejects an unsafe member prefix: %s", (_label, value) => {
    expect(() => parseMemberSearchPrefix(value)).toThrow();
  });

  it("folds case and outer whitespace into one member search key", () => {
    expect(aliasSearchPrefixKey("  FR  ")).toBe("fr");
    expect(aliasSearchPrefixKey("\uFF26\uFF32")).toBe("fr");
    expect(aliasSearchPrefixKey("fr")).toBe(aliasSearchPrefixKey("Fr"));
  });

  it("strictly validates opaque group IDs and existing Stream channel IDs", () => {
    expect(
      parseCommunicationGroupId("6d12a86e-4134-47e6-9312-c5ef75a30f55"),
    ).toBe("6d12a86e-4134-47e6-9312-c5ef75a30f55");
    expect(parseStreamChannelId("group_alpha-01")).toBe("group_alpha-01");
    expect(() => parseStreamChannelId("messaging:group")).toThrow();
    expect(() => parseStreamChannelId("../group")).toThrow();
  });
});
