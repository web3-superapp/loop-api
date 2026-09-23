import { reasonCodePatternSource } from "../../features/chain/chain-contract.js";
import {
  tokenLogoAllowedHosts,
  tokenLogoMaximumUrlLength,
  tokenLogoSources,
} from "../../features/market/token-logo.js";

/**
 * Anchored HTTPS URL on one of the allow-listed logo hosts (Decision 0072).
 * The pattern is the published contract; the server applies the same gate
 * before a URL reaches a response.
 */
export const tokenLogoUrlPatternSource = `^https://(${tokenLogoAllowedHosts
  .map((host) => host.replace(/\./g, "\\."))
  .join("|")})/[^\\s]+$`;

/**
 * One asset's logo, or why none is published. Shared by every surface that
 * lists an asset row so a client renders every token picture through one
 * codec.
 */
export const tokenLogoSchema = {
  description:
    "The asset's logo (Decision 0072). `available`: an https URL on cdn.dexscreener.com, dd.dexscreener.com, or raw.githubusercontent.com only — `dexscreener` is the image DexScreener reported on the asset's own base pair, observed at `observedAt`; `trustwallet` is the Trust Wallet assets-repository rule URL for the address and is never probed by the server (`observedAt` is null). Load it directly; on any load failure fall back to the client monogram and do not retry in a loop. `unavailable`: no rule URL could be formed (no base token address, or a chain the rule does not cover).",
  anyOf: [
    {
      type: "object",
      additionalProperties: false,
      required: ["status", "url", "source", "observedAt"],
      properties: {
        status: { type: "string", const: "available" },
        url: {
          type: "string",
          pattern: tokenLogoUrlPatternSource,
          maxLength: tokenLogoMaximumUrlLength,
        },
        source: { type: "string", enum: [...tokenLogoSources] },
        observedAt: {
          anyOf: [{ type: "string", format: "date-time" }, { type: "null" }],
        },
      },
    },
    {
      type: "object",
      additionalProperties: false,
      required: ["status", "reasonCode"],
      properties: {
        status: { type: "string", const: "unavailable" },
        reasonCode: { type: "string", pattern: reasonCodePatternSource },
      },
    },
  ],
} as const;
