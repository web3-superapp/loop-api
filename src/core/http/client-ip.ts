import type { IncomingHttpHeaders } from "node:http";
import { BlockList, isIP } from "node:net";

export class InvalidClientIpError extends Error {
  constructor() {
    super("The client IP is invalid");
    this.name = "InvalidClientIpError";
  }
}

/**
 * Canonicalizes Fastify's already-selected client IP before it is used as a
 * privacy-preserving quota subject. The raw address must never be persisted.
 */
export function canonicalizeClientIp(rawValue: string): string {
  if (rawValue.length === 0 || rawValue.length > 45) {
    throw new InvalidClientIpError();
  }

  const version = isIP(rawValue);

  if (version === 4) {
    return rawValue
      .split(".")
      .map((part) => String(Number(part)))
      .join(".");
  }

  if (version === 6) {
    try {
      const hostname = new URL(`http://[${rawValue}]/`).hostname;
      const canonical = hostname.slice(1, -1).toLowerCase();
      const mappedIpv4 = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(
        canonical,
      );

      if (mappedIpv4?.[1] !== undefined && mappedIpv4[2] !== undefined) {
        const high = Number.parseInt(mappedIpv4[1], 16);
        const low = Number.parseInt(mappedIpv4[2], 16);
        return [high >>> 8, high & 0xff, low >>> 8, low & 0xff].join(".");
      }

      return canonical;
    } catch {
      throw new InvalidClientIpError();
    }
  }

  throw new InvalidClientIpError();
}

/**
 * Decision 0147 revision S211: the forwarded-address headers the public
 * surface may read, in their fixed order of preference.
 * - `cf-connecting-ip`: set (overwritten) by Cloudflare's edge.
 * - `x-real-ip`: set by a reverse proxy configured to do so (Caddy does
 *   not set it by default and passes a client's own value through).
 * - `x-forwarded-for`: the right-most non-private entry (proxies append;
 *   Caddy without `trusted_proxies` replaces it with the peer address).
 */
export const publicClientIpHeaderNames = [
  "cf-connecting-ip",
  "x-real-ip",
  "x-forwarded-for",
] as const;
export type PublicClientIpHeaderName =
  (typeof publicClientIpHeaderNames)[number];

const nonPublicAddresses = new BlockList();
for (const [network, prefix] of [
  ["0.0.0.0", 8],
  ["10.0.0.0", 8],
  ["100.64.0.0", 10],
  ["127.0.0.0", 8],
  ["169.254.0.0", 16],
  ["172.16.0.0", 12],
  ["192.168.0.0", 16],
] as const) {
  nonPublicAddresses.addSubnet(network, prefix, "ipv4");
}
for (const [network, prefix] of [
  ["::", 128],
  ["::1", 128],
  ["fc00::", 7],
  ["fe80::", 10],
] as const) {
  nonPublicAddresses.addSubnet(network, prefix, "ipv6");
}

/** True for loopback, RFC 1918, CGNAT, link-local, ULA and unspecified. */
export function isNonPublicIp(canonical: string): boolean {
  const version = isIP(canonical);
  if (version === 0) return true;
  return nonPublicAddresses.check(canonical, version === 4 ? "ipv4" : "ipv6");
}

function canonicalOrNull(rawValue: string): string | null {
  let value = rawValue.trim();
  // `[v6]:port` / `[v6]` and `v4:port` forms some proxies write.
  const bracketed = /^\[([^\]]+)\](?::\d{1,5})?$/u.exec(value);
  if (bracketed?.[1] !== undefined) value = bracketed[1];
  else if (/^\d{1,3}(?:\.\d{1,3}){3}:\d{1,5}$/u.test(value)) {
    value = value.slice(0, value.lastIndexOf(":"));
  }
  try {
    return canonicalizeClientIp(value);
  } catch {
    return null;
  }
}

function headerText(value: string | string[] | undefined): string | null {
  if (value === undefined) return null;
  return Array.isArray(value) ? value.join(",") : value;
}

/** A single-address header: exactly one valid public address, else null. */
function singleAddress(value: string | string[] | undefined): string | null {
  const text = headerText(value);
  if (text === null || text.includes(",")) return null;
  const canonical = canonicalOrNull(text);
  return canonical === null || isNonPublicIp(canonical) ? null : canonical;
}

/** The right-most valid public entry of `X-Forwarded-For`, else null. */
function rightmostPublicForwardedFor(
  value: string | string[] | undefined,
): string | null {
  const text = headerText(value);
  if (text === null) return null;
  const entries = text.split(",");
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const canonical = canonicalOrNull(entries[index] ?? "");
    if (canonical !== null && !isNonPublicIp(canonical)) return canonical;
  }
  return null;
}

/**
 * Decision 0147 revision S211: the visitor key of the public surface's
 * per-IP rate limit. With `trustProxy` off it is `request.ip`. With it on,
 * the first of `headers` (in the given order) that yields a public
 * address wins; none → `request.ip`. Never logged or persisted.
 *
 * `request.ip` is not used first because behind a proxy that is not on
 * Fastify's loopback trust list it is the proxy's own address (every
 * visitor shares one bucket), and a left-most `X-Forwarded-For` is the
 * client's own claim.
 */
export function publicClientKey(
  request: { readonly ip: string; readonly headers: IncomingHttpHeaders },
  trustProxy: boolean,
  headers: readonly PublicClientIpHeaderName[] = publicClientIpHeaderNames,
): string {
  if (!trustProxy) return request.ip;
  for (const name of headers) {
    const value = request.headers[name];
    const address =
      name === "x-forwarded-for"
        ? rightmostPublicForwardedFor(value)
        : singleAddress(value);
    if (address !== null) return address;
  }
  return request.ip;
}
