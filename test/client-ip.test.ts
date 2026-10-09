import { describe, expect, it } from "vitest";

import {
  canonicalizeClientIp,
  InvalidClientIpError,
} from "../src/core/http/client-ip.js";

describe("canonicalizeClientIp", () => {
  it("preserves canonical IPv4 addresses", () => {
    expect(canonicalizeClientIp("203.0.113.10")).toBe("203.0.113.10");
  });

  it("normalizes equivalent IPv6 forms", () => {
    expect(canonicalizeClientIp("0:0:0:0:0:0:0:1")).toBe("::1");
    expect(canonicalizeClientIp("::ffff:192.0.2.1")).toBe("192.0.2.1");
    expect(canonicalizeClientIp("::FFFF:C000:0201")).toBe("192.0.2.1");
  });

  it.each([
    "",
    "203.0.113.10:443",
    "203.0.113.999",
    " 203.0.113.10",
    "client.example",
    "x".repeat(46),
  ])("rejects a non-canonicalizable address without echoing it", (value) => {
    expect(() => canonicalizeClientIp(value)).toThrow(InvalidClientIpError);

    try {
      canonicalizeClientIp(value);
    } catch (error) {
      if (value !== "") {
        expect(String(error)).not.toContain(value);
      }
    }
  });
});
