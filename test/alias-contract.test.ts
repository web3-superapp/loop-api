import { describe, expect, it } from "vitest";

import {
  parseAliasSearchLimit,
  parseAliasSearchPrefix,
  parseCommunicationGroupId,
  parseGroupAlias,
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

  it("strictly validates opaque group IDs and existing Stream channel IDs", () => {
    expect(
      parseCommunicationGroupId("6d12a86e-4134-47e6-9312-c5ef75a30f55"),
    ).toBe("6d12a86e-4134-47e6-9312-c5ef75a30f55");
    expect(parseStreamChannelId("group_alpha-01")).toBe("group_alpha-01");
    expect(() => parseStreamChannelId("messaging:group")).toThrow();
    expect(() => parseStreamChannelId("../group")).toThrow();
  });
});
