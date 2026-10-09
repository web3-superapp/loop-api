import { isIP } from "node:net";

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
