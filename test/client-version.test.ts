import { describe, expect, it } from "vitest";

import {
  compareClientVersions,
  isValidClientVersion,
} from "../src/features/session/client-version.js";

describe("client version precedence", () => {
  it.each([
    ["1.0.0", "1.0.0", 0],
    ["1.0.0", "1.0.1", -1],
    ["1.10.0", "1.9.0", 1],
    ["2.0.0", "10.0.0", -1],
    ["1.0.0-alpha", "1.0.0", -1],
    ["1.0.0-alpha", "1.0.0-alpha.1", -1],
    ["1.0.0-alpha.1", "1.0.0-alpha.beta", -1],
    ["1.0.0-beta.2", "1.0.0-beta.11", -1],
    ["1.0.0-rc.1", "1.0.0-rc.1", 0],
    ["1.0.0+build.1", "1.0.0+build.2", 0],
    ["1.0.0-alpha+1", "1.0.0-alpha", 0],
  ])("orders %s against %s as %i", (left, right, expected) => {
    expect(compareClientVersions(left, right)).toBe(expected);
    expect(compareClientVersions(right, left)).toBe(
      expected === 0 ? 0 : -expected,
    );
  });

  it("refuses to compare invalid versions", () => {
    expect(isValidClientVersion("01.0.0")).toBe(false);
    expect(() => compareClientVersions("01.0.0", "1.0.0")).toThrow(TypeError);
    expect(() => compareClientVersions("1.0.0", "v1.0.0")).toThrow(TypeError);
  });
});
