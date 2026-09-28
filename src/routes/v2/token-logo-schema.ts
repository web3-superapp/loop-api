import { reasonCodePatternSource } from "../../features/chain/chain-contract.js";
import {
  tokenLogoMaximumUrlLength,
  tokenLogoProxyChainIds,
  tokenLogoProxyPathPrefix,
  tokenLogoSources,
} from "../../features/market/token-logo.js";

/**
 * The logo proxy route of this API (Decision 0089): any `http(s)` origin
 * (`PUBLIC_BASE_URL`, which production requires to be https), then
 * `/v2/market/logos/<chainId>/<lowercase 0x address | native>.png`. The
 * server builds the URL; the pattern is the published contract.
 */
export const tokenLogoUrlPatternSource = `^https?://[^\\s/?#]+(/[^\\s?#]*)?${tokenLogoProxyPathPrefix}/(${tokenLogoProxyChainIds
  .map((chainId) => chainId.replace(/\./g, "\\."))
  .join("|")})/(0x[0-9a-f]{40}|native)\\.png$`;

/**
 * One asset's logo, or why none is published. Shared by every surface that
 * lists an asset row so a client renders every token picture through one
 * codec.
 */
export const tokenLogoSchema = {
  description:
    "The asset's logo (Decisions 0072, 0089). `available`: `url` is always this API's own logo proxy, `<PUBLIC_BASE_URL>/v2/market/logos/<chainId>/<lowercase address | native>.png` (no auth, no LOOP headers, CDN-cacheable), which fetches and caches the picture server-side. `source` names the origin the projection chose: `dexscreener` is the image DexScreener reported on the asset's own base pair, observed at `observedAt`; `trustwallet` is the Trust Wallet assets-repository rule for the address (`observedAt` is null). The proxy may still answer 404 (no picture exists) or 502 (upstream unreachable): on any load failure fall back to the client monogram and do not retry in a loop. `unavailable`: no rule URL could be formed (no base token address, or a chain the rule does not cover), or the logo proxy is not served (`TOKEN_LOGO_PROXY_UNAVAILABLE`).",
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
