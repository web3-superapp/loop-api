import { describe, expect, it } from "vitest";

import {
  generateOpaqueId,
  InvalidOpaqueIdError,
  isOpaqueId,
  opaqueIdPatternSource,
  parseOpaqueId,
} from "../src/core/ids/opaque-id.js";

describe("opaque IDs", () => {
  it("generates distinct canonical lowercase UUIDv4 values", () => {
    const first = generateOpaqueId();
    const second = generateOpaqueId();

    expect(first).toMatch(new RegExp(opaqueIdPatternSource));
    expect(second).toMatch(new RegExp(opaqueIdPatternSource));
    expect(first).not.toBe(second);
    expect(parseOpaqueId(first)).toBe(first);
  });

  it.each([
    ["uppercase", "6D12A86E-4134-47E6-9312-C5EF75A30F55"],
    ["non-v4 version", "6d12a86e-4134-17e6-9312-c5ef75a30f55"],
    ["invalid variant", "6d12a86e-4134-47e6-c312-c5ef75a30f55"],
    ["wallet address", "0x11111111111111111111111111111111111111aa"],
    ["ticker", "USD1"],
    ["empty", ""],
  ])("rejects %s", (_name, value) => {
    expect(isOpaqueId(value)).toBe(false);
    expect(() => parseOpaqueId(value)).toThrow(InvalidOpaqueIdError);
  });

  it("rejects non-string input", () => {
    expect(isOpaqueId(42)).toBe(false);
    expect(isOpaqueId(null)).toBe(false);
    expect(() => parseOpaqueId(undefined)).toThrow(InvalidOpaqueIdError);
  });
});
