import { describe, expect, it } from "vitest";

import { ConfigurationError } from "../src/config.js";
import {
  assertLaunchTextUnicodeRuntime,
  runtimeUnicodeMajor,
} from "../src/core/runtime/unicode-runtime.js";

/** Decision 0168 (S255 audit I-20): refuse to start below Unicode 14. */
describe("launch text Unicode runtime assertion (Decision 0168)", () => {
  it("passes on this runtime (Node 24.19, Unicode 17)", () => {
    expect(runtimeUnicodeMajor(process.versions)).toBeGreaterThanOrEqual(14);
    expect(() => {
      assertLaunchTextUnicodeRuntime();
    }).not.toThrow();
  });

  it("parses the major version", () => {
    expect(runtimeUnicodeMajor({ unicode: "17.0" })).toBe(17);
    expect(runtimeUnicodeMajor({ unicode: "14.0" })).toBe(14);
    expect(runtimeUnicodeMajor({})).toBeNull();
    expect(runtimeUnicodeMajor({ unicode: "x" })).toBeNull();
  });

  it.each([[{ unicode: "13.0" }], [{ unicode: "" }], [{}]])(
    "refuses %o with a clear configuration error",
    (versions) => {
      expect(() => {
        assertLaunchTextUnicodeRuntime(versions, () => true);
      }).toThrow(ConfigurationError);
      expect(() => {
        assertLaunchTextUnicodeRuntime(versions, () => true);
      }).toThrow(/Unicode tables must be 14 or newer/u);
    },
  );

  it("refuses when the regex tables disagree with the reported version", () => {
    expect(() => {
      assertLaunchTextUnicodeRuntime({ unicode: "17.0" }, () => false);
    }).toThrow(ConfigurationError);
    expect(() => {
      assertLaunchTextUnicodeRuntime({ unicode: "14.0" }, () => true);
    }).not.toThrow();
  });
});
