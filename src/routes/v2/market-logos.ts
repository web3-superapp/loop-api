import type { FastifyInstance } from "fastify";

import { assertNoBodyOrQuery } from "../../core/http/request-input.js";
import { emptyQueryStringSchema } from "../../core/http/schemas.js";
import { V2ApiError, v2ErrorResponseSchema } from "../../core/http/v2-error.js";
import {
  ifNoneMatchSatisfied,
  type TokenLogoProxyService,
} from "../../features/market/token-logo-proxy.js";
import {
  tokenLogoProxyNativeFile,
  tokenLogoProxyPathPrefix,
  tokenLogoProxyReadChainIds,
} from "../../features/market/token-logo.js";
import { tokenLogoContentTypes } from "../../database/token-logo-cache-repository.js";

/**
 * `GET /v2/market/logos/{chainId}/{file}` (Decision 0089): the token logo
 * proxy every published `logo.url` points at.
 *
 * It is a public, cacheable image resource, not a JSON contract call: an
 * image loader sends no Bearer, no `X-Loop-Contract-Version`, and no LOOP
 * headers, so the route requires none. It reveals nothing a user owns — the
 * picture of a public token contract — and only its two path segments are
 * input: a chain from the fixed list and `0x` + 40 hex (or `native`). The
 * upstream URL is never taken from the request.
 *
 * Decision 0161: the bytes are the stored 128 x 128 WebP whatever the
 * suffix; `.png` stays the published name (shipped clients match it) and
 * `.webp` names the same resource. Ethereum and Base are readable too; only
 * BSC is published in `logo.url`. No `302` any more.
 */

/** Browsers and CDNs may keep a picture for a day and revalidate for a week. */
export const tokenLogoCacheControl =
  "public, max-age=86400, stale-while-revalidate=604800";

/** A picture served from a lower origin because a higher one failed. */
export const tokenLogoDegradedCacheControl = "public, max-age=300";

const nativeStem = tokenLogoProxyNativeFile.replace(".png", "");
const filePatternSource = `^(0x[0-9a-fA-F]{40}|${nativeStem})\\.(png|webp)$`;
const filePattern = new RegExp(filePatternSource);

const paramsSchema = {
  type: "object",
  additionalProperties: false,
  required: ["chainId", "file"],
  properties: {
    chainId: {
      type: "string",
      enum: [...tokenLogoProxyReadChainIds],
      description:
        "CAIP-2 chain: BSC mainnet (the only chain published in `logo.url`), Ethereum mainnet, or Base.",
    },
    file: {
      type: "string",
      pattern: filePatternSource,
      description:
        "`<0x + 40 hex token address>.png` (any case; published URLs are lowercase) or `native.png` for the chain's native coin. `.webp` is the same resource; the bytes are WebP under either name.",
    },
  },
} as const;

const imageBodySchema = { type: "string", format: "binary" } as const;

const logoErrors = {
  400: v2ErrorResponseSchema(["INVALID_REQUEST"]),
  404: v2ErrorResponseSchema(["NOT_FOUND"]),
  500: v2ErrorResponseSchema(["INTERNAL_ERROR"]),
  502: v2ErrorResponseSchema(["PROVIDER_UNREACHABLE"]),
  503: v2ErrorResponseSchema(["REQUEST_TIMEOUT"]),
} as const;

export function registerV2MarketLogoRoute(
  app: FastifyInstance,
  service: TokenLogoProxyService,
): void {
  app.get(
    `${tokenLogoProxyPathPrefix}/:chainId/:file`,
    {
      schema: {
        operationId: "getV2MarketTokenLogo",
        summary: "Get a token logo through the LOOP logo proxy",
        description:
          "Public image resource (Decisions 0089, 0161); no authentication and no LOOP headers. The server picks the picture by the Decision 0072 origin rules (on BSC the DexScreener image of the token's own base pair when the pair fact has one, else the Trust Wallet assets-repository file of the chain), fetches it once with a 5 s timeout, re-encodes it into a 128 x 128 WebP (transparency kept), and keeps it for 7 days; the worker pre-warms the mainstream, registry, watchlisted and hot BSC tokens. An operator picture (`source = manual`) is served until cleared. 200: `image/webp` bytes (rows stored before Decision 0161 may still answer PNG/JPEG/GIF until their refresh) with a strong `ETag`; `If-None-Match` answers 304. 404 `NOT_FOUND`: no origin has a picture, the upstream picture is larger than 4 MiB or cannot be decoded (remembered for 24 h). 502 `PROVIDER_UNREACHABLE`: the upstream timed out or failed and nothing is stored. On any non-200 the client draws its monogram and does not retry in a loop.",
        tags: ["market"],
        security: [],
        params: paramsSchema,
        querystring: emptyQueryStringSchema,
        response: {
          200: {
            description:
              "The logo bytes. `Cache-Control: public, max-age=86400, stale-while-revalidate=604800` (or `public, max-age=300` when a higher-priority origin failed and a lower one was served), `ETag`, `X-Content-Type-Options: nosniff`.",
            content: Object.fromEntries(
              tokenLogoContentTypes.map((type) => [
                type,
                { schema: imageBodySchema },
              ]),
            ),
          },
          304: {
            description: "`If-None-Match` matched the current `ETag`.",
            type: "null",
          },
          ...logoErrors,
        },
      },
      preValidation: assertNoBodyOrQuery,
    },
    async (request, reply) => {
      const params = request.params as {
        readonly chainId: string;
        readonly file: string;
      };
      const match = filePattern.exec(params.file);
      if (match === null) {
        throw V2ApiError.invalidRequest();
      }
      const stem = match[1] ?? "";
      const address = stem === nativeStem ? null : stem.toLowerCase();
      const result = await service.resolve({
        chainId: params.chainId,
        address,
      });
      switch (result.kind) {
        case "image": {
          reply.header(
            "cache-control",
            result.durable
              ? tokenLogoCacheControl
              : tokenLogoDegradedCacheControl,
          );
          reply.header("etag", result.etag);
          reply.header("x-content-type-options", "nosniff");
          if (
            ifNoneMatchSatisfied(request.headers["if-none-match"], result.etag)
          ) {
            return reply.code(304).send();
          }
          reply.header("content-type", result.contentType);
          return reply.code(200).send(result.bytes);
        }
        case "missing":
          throw V2ApiError.notFound();
        case "unreachable":
          throw V2ApiError.fromCode("PROVIDER_UNREACHABLE");
      }
    },
  );
}
