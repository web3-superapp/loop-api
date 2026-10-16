import type { IncomingHttpHeaders } from "node:http";

import { describe, expect, it } from "vitest";

import { ConfigurationError, loadConfig } from "../src/config.js";
import { isNonPublicIp, publicClientKey } from "../src/core/http/client-ip.js";

// Decision 0147 revision S211: the public surface's visitor key.
const proxy = "172.18.0.5"; // the Caddy / cloudflared container as Fastify sees it
const request = (headers: IncomingHttpHeaders, ip = proxy) => ({ ip, headers });

describe("publicClientKey (Decision 0147 S211)", () => {
  it("keeps request.ip when TRUST_PROXY is off, whatever the headers say", () => {
    const headers = {
      "cf-connecting-ip": "198.51.100.1",
      "x-real-ip": "198.51.100.2",
      "x-forwarded-for": "198.51.100.3",
    };
    expect(publicClientKey(request(headers), false)).toBe(proxy);
  });

  it("prefers cf-connecting-ip, then x-real-ip, then x-forwarded-for", () => {
    const all = {
      "cf-connecting-ip": "198.51.100.1",
      "x-real-ip": "198.51.100.2",
      "x-forwarded-for": "198.51.100.3",
    };
    expect(publicClientKey(request(all), true)).toBe("198.51.100.1");
    const noCf = {
      "x-real-ip": all["x-real-ip"],
      "x-forwarded-for": all["x-forwarded-for"],
    };
    expect(publicClientKey(request(noCf), true)).toBe("198.51.100.2");
    expect(
      publicClientKey(request({ "x-forwarded-for": "198.51.100.3" }), true),
    ).toBe("198.51.100.3");
    expect(publicClientKey(request({}), true)).toBe(proxy);
  });

  it("reads only the configured headers, in the configured order", () => {
    const headers = {
      "cf-connecting-ip": "198.51.100.1",
      "x-real-ip": "198.51.100.2",
      "x-forwarded-for": "198.51.100.3",
    };
    expect(publicClientKey(request(headers), true, ["x-forwarded-for"])).toBe(
      "198.51.100.3",
    );
    expect(
      publicClientKey(request(headers), true, [
        "x-real-ip",
        "cf-connecting-ip",
      ]),
    ).toBe("198.51.100.2");
    expect(publicClientKey(request(headers), true, [])).toBe(proxy);
  });

  it("takes the right-most public X-Forwarded-For entry, so a forged left part is ignored", () => {
    // The client sent `X-Forwarded-For: 1.2.3.4`; the proxy appended the peer.
    expect(
      publicClientKey(
        request({ "x-forwarded-for": "1.2.3.4, 203.0.113.7" }),
        true,
      ),
    ).toBe("203.0.113.7");
    // Private hops appended by internal proxies are skipped.
    expect(
      publicClientKey(
        request({
          "x-forwarded-for": "6.6.6.6, 203.0.113.7, 10.0.0.2, 172.18.0.3",
        }),
        true,
      ),
    ).toBe("203.0.113.7");
    // Duplicate headers arrive as one list (Node joins them) or an array.
    expect(
      publicClientKey(
        request({ "x-forwarded-for": ["6.6.6.6", "203.0.113.8"] as never }),
        true,
      ),
    ).toBe("203.0.113.8");
    // Garbage entries are skipped, not trusted.
    expect(
      publicClientKey(
        request({ "x-forwarded-for": "203.0.113.9, not-an-ip, unknown" }),
        true,
      ),
    ).toBe("203.0.113.9");
  });

  it("falls back to request.ip when every forwarded entry is private or invalid", () => {
    expect(
      publicClientKey(
        request({
          "x-forwarded-for": "10.1.2.3, 192.168.1.1, 127.0.0.1, 100.64.0.1",
        }),
        true,
      ),
    ).toBe(proxy);
    expect(
      publicClientKey(
        request({ "x-forwarded-for": "fe80::1, fd00::2, ::1" }),
        true,
      ),
    ).toBe(proxy);
    expect(publicClientKey(request({ "x-forwarded-for": "" }), true)).toBe(
      proxy,
    );
  });

  it("rejects a private, invalid, or multi-valued single-address header and moves on", () => {
    const xff = { "x-forwarded-for": "203.0.113.20" };
    for (const value of [
      "10.0.0.1",
      "::1",
      "garbage",
      "198.51.100.1, 198.51.100.2",
      "",
    ]) {
      expect(
        publicClientKey(
          request({ "cf-connecting-ip": value, "x-real-ip": value, ...xff }),
          true,
        ),
      ).toBe("203.0.113.20");
    }
  });

  it("canonicalizes IPv6 and IPv4-mapped forms so one visitor is one key", () => {
    expect(
      publicClientKey(
        request({ "cf-connecting-ip": "2001:DB8:0:0:0:0:0:1" }),
        true,
      ),
    ).toBe("2001:db8::1");
    expect(
      publicClientKey(request({ "x-real-ip": "::ffff:203.0.113.5" }), true),
    ).toBe("203.0.113.5");
    expect(
      publicClientKey(
        request({ "x-forwarded-for": "1.1.1.1, [2001:db8::2]:4430" }),
        true,
      ),
    ).toBe("2001:db8::2");
    expect(
      publicClientKey(
        request({ "x-forwarded-for": "203.0.113.6:51234" }),
        true,
      ),
    ).toBe("203.0.113.6");
  });

  it("classifies non-public ranges", () => {
    for (const address of [
      "10.0.0.1",
      "172.16.0.1",
      "172.31.255.255",
      "192.168.0.1",
      "127.0.0.1",
      "169.254.1.1",
      "100.64.0.1",
      "0.0.0.0",
      "::",
      "::1",
      "fc00::1",
      "fd12::1",
      "fe80::1",
      "nonsense",
    ]) {
      expect(isNonPublicIp(address)).toBe(true);
    }
    for (const address of [
      "172.32.0.1",
      "203.0.113.1",
      "2001:db8::1",
      "1.1.1.1",
    ]) {
      expect(isNonPublicIp(address)).toBe(false);
    }
  });
});

describe("public rate limit configuration (Decision 0147 S211)", () => {
  const base = {
    NODE_ENV: "test",
    LOG_LEVEL: "silent",
    DATABASE_URL:
      "postgres://loop_api:local-password@127.0.0.1:5432/loop_api_test",
  } as const;

  it("defaults to 120 per minute keyed on the right-most public X-Forwarded-For", () => {
    const config = loadConfig({ ...base });
    expect(config.publicRateLimit.perMinute).toBe(120);
    expect(config.publicRateLimit.clientIpHeaders).toEqual(["x-forwarded-for"]);
  });

  it("parses the limit within 10–10000 and an ordered header list", () => {
    const config = loadConfig({
      ...base,
      PUBLIC_RATE_LIMIT_PER_MINUTE: "600",
      PUBLIC_CLIENT_IP_HEADERS: "cf-connecting-ip, X-Real-IP,x-forwarded-for",
    });
    expect(config.publicRateLimit.perMinute).toBe(600);
    expect(config.publicRateLimit.clientIpHeaders).toEqual([
      "cf-connecting-ip",
      "x-real-ip",
      "x-forwarded-for",
    ]);
    expect(
      loadConfig({ ...base, PUBLIC_CLIENT_IP_HEADERS: "none" }).publicRateLimit
        .clientIpHeaders,
    ).toEqual([]);
  });

  it.each([
    { PUBLIC_RATE_LIMIT_PER_MINUTE: "9" },
    { PUBLIC_RATE_LIMIT_PER_MINUTE: "10001" },
    { PUBLIC_RATE_LIMIT_PER_MINUTE: "12.5" },
    { PUBLIC_CLIENT_IP_HEADERS: "true-client-ip" },
    { PUBLIC_CLIENT_IP_HEADERS: "x-real-ip,x-real-ip" },
    { PUBLIC_CLIENT_IP_HEADERS: "x-real-ip,,x-forwarded-for" },
  ])("refuses to start on %o", (override) => {
    expect(() => loadConfig({ ...base, ...override })).toThrow(
      ConfigurationError,
    );
  });
});
