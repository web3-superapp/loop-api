import { describe, expect, it } from "vitest";

import {
  aliasReservedWords,
  createAliasPolicy,
  findBlockedTerm,
  isReservedAlias,
  normalizeAliasForPolicy,
} from "../src/features/profile/alias-policy.js";

describe("V2 alias policy", () => {
  it("compiles the ruling's reserved words", () => {
    expect([...aliasReservedWords]).toEqual([
      "loop",
      "admin",
      "official",
      "support",
      "system",
      "mod",
      "moderator",
      "team",
    ]);
  });

  it.each([
    "loop",
    "LOOP",
    "Loop",
    "admin",
    "ADMIN",
    "Official",
    "support",
    "System",
    "mod",
    "Moderator",
    "team",
    "admin123",
    "123admin",
    "admin_2026",
    "x_admin",
    "the-admin",
    "LOOP Team",
    "loop_official",
    "loopadmin",
    "official-loop",
    "LoopSupport",
    "mod.7",
    "ＬＯＯＰ",
    "ｌｏｏｐ",
    "  admin  ",
    "loop team",
    "Loop 😀 Fan",
    "LoopSupportBot",
    "AdminAlice",
    "OfficialLoopHelp",
    "superadmin",
    "adminx",
    "administrator",
    "supporter",
    "systematic",
    "Officially Alice",
    "admins",
  ])("treats %j as reserved", (alias) => {
    expect(isReservedAlias(alias)).toBe(true);
  });

  it.each([
    "Alice",
    "loopy",
    "looper",
    "modern",
    "teams",
    "Alice Adm",
    "hoop",
    "badminton",
    "unsupported",
    "loopyteam",
    "Alice 😀 Fan",
    "mod3rn",
  ])("allows %j", (alias) => {
    expect(isReservedAlias(alias)).toBe(false);
  });

  it("normalises NFKC, case, and whitespace before matching", () => {
    expect(normalizeAliasForPolicy("  Ｓｃａｍ   Coin ")).toBe("scam coin");
  });

  it("matches blocked terms as normalised substrings", () => {
    expect(findBlockedTerm("Best SCAM coin", ["scam"])).toBe("scam");
    expect(findBlockedTerm("ＳＣＡＭ", ["scam"])).toBe("scam");
    expect(findBlockedTerm("s c a m", ["scam"])).toBe("scam");
    expect(findBlockedTerm("Alice", ["scam"])).toBeNull();
    expect(findBlockedTerm("Alice", [])).toBeNull();
    for (const alias of ["rugpull", "rug-pull", "Rug_Pull", "RUG  PULL"]) {
      expect(findBlockedTerm(alias, ["rug pull"])).toBe("rug pull");
    }
    expect(findBlockedTerm("rug", ["rug pull"])).toBeNull();
  });

  it("evaluates reserved before blocked and allows ordinary aliases", () => {
    const policy = createAliasPolicy({ blockedTerms: [" SCAM ", "admin", ""] });

    expect(policy.blockedTerms).toEqual(["scam", "admin"]);
    expect(policy.evaluate("admin")).toEqual({ status: "reserved" });
    expect(policy.evaluate("scam artist")).toEqual({ status: "blocked" });
    expect(policy.evaluate("Alice")).toEqual({ status: "allowed" });
    expect(Object.isFrozen(policy)).toBe(true);
  });
});
