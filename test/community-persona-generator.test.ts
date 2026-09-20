import { describe, expect, it } from "vitest";

import {
  communityPersonaAliasPatternSource,
  communityPersonaWords,
  createCommunityPersonaAliasGenerator,
  generateCommunityPersonaAlias,
  isCommunityPersonaAlias,
} from "../src/features/communication/community-persona-generator.js";

const aliasPattern = new RegExp(communityPersonaAliasPatternSource);
const forbiddenFragments = [
  "loop",
  "stream",
  "privy",
  "hyperliquid",
  "bsc",
  "binance",
  "apple",
  "google",
  "meta",
  "amazon",
  "tesla",
  "sky",
  "shell",
  "delta",
  "mango",
  "orbit",
  "tide",
  "dawn",
];

describe("community persona generator (Decision 0055)", () => {
  it("ships at least 200 unique, sorted, neutral words", () => {
    expect(communityPersonaWords.length).toBeGreaterThanOrEqual(200);
    expect(new Set(communityPersonaWords).size).toBe(
      communityPersonaWords.length,
    );
    expect(
      [...communityPersonaWords].sort((a, b) => a.localeCompare(b, "en")),
    ).toEqual([...communityPersonaWords]);
    for (const word of communityPersonaWords) {
      expect(word).toMatch(/^[A-Z][a-z]{2,15}$/);
      expect(forbiddenFragments).not.toContain(word.toLowerCase());
    }
  });

  it("produces <Word>-<4 digits> from an injected random source", () => {
    const draws = [3, 7];
    const alias = generateCommunityPersonaAlias(() => draws.shift() ?? 0);
    expect(alias).toBe(`${communityPersonaWords[3] ?? ""}-0007`);
    expect(alias).toMatch(aliasPattern);
    expect(isCommunityPersonaAlias(alias)).toBe(true);
  });

  it("pads the digits and never emits an identifier fragment", () => {
    const zero = generateCommunityPersonaAlias(() => 0);
    expect(zero).toBe("Acorn-0000");
    const max = generateCommunityPersonaAlias((bound) => bound - 1);
    expect(max).toBe(`${communityPersonaWords.at(-1) ?? ""}-9999`);
    for (let i = 0; i < 200; i += 1) {
      const alias = generateCommunityPersonaAlias();
      expect(alias).toMatch(aliasPattern);
      expect(alias.toLowerCase()).not.toMatch(/loop_|[0-9a-f]{8}-/);
    }
  });

  it("fails closed on a random source that leaves the bounds", () => {
    expect(() => generateCommunityPersonaAlias(() => 10_000)).toThrow();
    expect(() => generateCommunityPersonaAlias(() => -1)).toThrow();
    expect(() => generateCommunityPersonaAlias(() => 1.5)).toThrow();
  });

  it("rejects anything that is not the persona shape", () => {
    for (const value of [
      "",
      "Owl",
      "Owl-123",
      "Owl-12345",
      "owl-1234",
      "OWL-1234",
      "Owl 1234",
      "cy",
      "loop_3bb585972e3145e7b5f0957803a824ed",
      1234,
      null,
    ]) {
      expect(isCommunityPersonaAlias(value)).toBe(false);
    }
  });

  it("exposes a stateless generator closure", () => {
    const generate = createCommunityPersonaAliasGenerator(() => 1);
    expect(generate()).toBe(`${communityPersonaWords[1] ?? ""}-0001`);
    expect(generate()).toBe(`${communityPersonaWords[1] ?? ""}-0001`);
  });
});
