import multipart from "@fastify/multipart";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";

import { requireAuthenticatedLoopPrincipal } from "../../core/http/authentication.js";
import { assertNoBodyOrQuery } from "../../core/http/request-input.js";
import { emptyQueryStringSchema } from "../../core/http/schemas.js";
import { V2ApiError, v2ErrorResponseSchema } from "../../core/http/v2-error.js";
import { parseV2CommandMetadata } from "../../features/community/community-contract.js";
import {
  ipfsCidPatternSource,
  mediaIdPatternSource,
  mediaMaximumUploadBytes,
  nftMediaRefPatternSource,
  mediaReasonCodes,
  type MediaKind,
} from "../../features/media/media-contract.js";
import {
  mediaIpfsUnavailableReason,
  mediaRejected,
} from "../../features/media/media-service.js";
import { ifNoneMatchSatisfied } from "../../features/market/token-logo-proxy.js";
import { v2ContractVersion } from "../../features/meta/product-policy.js";
import {
  v2CommandHeadersSchema,
  validateCommandHeaders,
} from "./community-schemas.js";
import type { V2RouteDependencies } from "./index.js";

/**
 * Media upload and read (Decision 0095). Registered with the `profile`
 * module. Multipart parsing is registered inside this plugin scope only, so
 * no other route starts accepting `multipart/form-data`.
 */

export const mediaCacheControl = "public, max-age=31536000, immutable";

const uploadResponseSchema = {
  type: "object",
  additionalProperties: false,
  required: ["mediaId", "ref", "url", "width", "height", "contractVersion"],
  properties: {
    mediaId: { type: "string", pattern: mediaIdPatternSource },
    ref: {
      type: "string",
      pattern:
        "^(avatar|logo):media/[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$",
      description:
        "`avatar:media/{mediaId}` (avatar upload) or `logo:media/{mediaId}` (community logo upload). Write it into `avatarRef` / `logoRef`.",
    },
    url: {
      type: "string",
      pattern:
        "^/v2/media/[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\\.webp$",
      description: "API-relative path; the client prefixes its API base URL.",
    },
    width: { type: "integer", minimum: 1, maximum: 4096 },
    height: { type: "integer", minimum: 1, maximum: 4096 },
    contractVersion: { type: "string", const: v2ContractVersion },
  },
} as const;

/** Decision 0173: `POST /v2/media/project-nft-images`. */
const nftUploadResponseSchema = {
  type: "object",
  additionalProperties: false,
  required: [
    "mediaId",
    "ref",
    "url",
    "mediaUrl",
    "cid",
    "ipfsUri",
    "width",
    "height",
    "contractVersion",
  ],
  properties: {
    mediaId: { type: "string", pattern: mediaIdPatternSource },
    ref: {
      type: "string",
      pattern: nftMediaRefPatternSource,
      description: "`nft:media/{mediaId}` (informational).",
    },
    url: {
      type: "string",
      maxLength: 2048,
      description:
        "The IPFS gateway URL `<IPFS_GATEWAY_BASE_URL>/<cid>` when pinned; else the API-relative media path. Use it as the draft's nftImageAssetUrl (made absolute).",
    },
    mediaUrl: {
      type: "string",
      pattern:
        "^/v2/media/[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\\.webp$",
      description: "API-relative path of the local copy (fallback).",
    },
    cid: {
      anyOf: [
        { type: "string", pattern: ipfsCidPatternSource },
        { type: "null" },
      ],
      description: "The IPFS CID; null when stored locally only.",
    },
    ipfsUri: {
      anyOf: [{ type: "string", maxLength: 128 }, { type: "null" }],
      description: "`ipfs://<cid>`; null when stored locally only.",
    },
    width: { type: "integer", minimum: 1, maximum: 4096 },
    height: { type: "integer", minimum: 1, maximum: 4096 },
    contractVersion: { type: "string", const: v2ContractVersion },
  },
} as const;

const uploadBodySchema = {
  content: {
    "multipart/form-data": {
      schema: {
        type: "object",
        additionalProperties: false,
        properties: {
          file: {
            type: "string",
            format: "binary",
            description:
              "Required, the only part. JPEG, PNG, WebP or HEIC/HEIF by content (not by declared type), at most 5 MiB, both sides at least 64 px. Stored as 512x512 cover WebP.",
          },
        },
      },
    },
  },
} as const;

const uploadErrors = {
  400: v2ErrorResponseSchema(["INVALID_REQUEST"]),
  401: v2ErrorResponseSchema(["AUTH_REQUIRED", "AUTH_INVALID"], {
    includeBearerChallenge: true,
  }),
  409: v2ErrorResponseSchema([
    "ACCOUNT_BOOTSTRAP_REQUIRED",
    "IDEMPOTENCY_CONFLICT",
  ]),
  422: v2ErrorResponseSchema(["VALIDATION_FAILED"]),
  429: v2ErrorResponseSchema(["RATE_LIMITED"]),
  500: v2ErrorResponseSchema(["INTERNAL_ERROR"]),
  503: v2ErrorResponseSchema([
    "CAPABILITY_UNAVAILABLE",
    "PROVIDER_DISCONNECTED",
    "REQUEST_TIMEOUT",
  ]),
} as const;

const readErrors = {
  400: v2ErrorResponseSchema(["INVALID_REQUEST"]),
  404: v2ErrorResponseSchema(["NOT_FOUND"]),
  500: v2ErrorResponseSchema(["INTERNAL_ERROR"]),
  503: v2ErrorResponseSchema(["CAPABILITY_UNAVAILABLE", "REQUEST_TIMEOUT"]),
} as const;

/** Lets the content-typed body schema validate a stream-consumed body. */
function prepareMultipartBody(request: FastifyRequest): Promise<void> {
  if (Object.keys(request.query as Record<string, unknown>).length > 0) {
    throw V2ApiError.invalidRequest();
  }
  if (request.isMultipart() && request.body === undefined) {
    request.body = {};
  }
  return Promise.resolve();
}

function errorCode(error: unknown): string | undefined {
  return typeof error === "object" &&
    error !== null &&
    "code" in error &&
    typeof error.code === "string"
    ? error.code
    : undefined;
}

/** Exactly one part named `file`, read fully into memory (<= 5 MiB). */
async function readSingleFile(request: FastifyRequest): Promise<Buffer> {
  if (!request.isMultipart()) {
    throw V2ApiError.invalidRequest();
  }
  try {
    const part = await request.file({
      limits: {
        fileSize: mediaMaximumUploadBytes,
        files: 1,
        fields: 0,
        parts: 1,
      },
    });
    if (part === undefined || part.fieldname !== "file") {
      throw V2ApiError.invalidRequest();
    }
    return await part.toBuffer();
  } catch (error) {
    if (error instanceof V2ApiError) {
      throw error;
    }
    if (errorCode(error) === "FST_REQ_FILE_TOO_LARGE") {
      throw mediaRejected(mediaReasonCodes.tooLarge);
    }
    throw V2ApiError.invalidRequest();
  }
}

export function registerV2MediaRoutes(
  app: FastifyInstance,
  dependencies: V2RouteDependencies,
): void {
  const { authenticateLoopBearer, mediaService } = dependencies;

  void app.register(async (scope) => {
    await scope.register(multipart, {
      throwFileSizeLimit: true,
      limits: {
        fileSize: mediaMaximumUploadBytes,
        files: 1,
        fields: 0,
        parts: 1,
      },
    });

    const upload =
      (kind: MediaKind) =>
      async (request: FastifyRequest, reply: FastifyReply) => {
        const metadata = parseV2CommandMetadata(request.raw.rawHeaders);
        const bytes = await readSingleFile(request);
        const resource = await mediaService.upload({
          principal: requireAuthenticatedLoopPrincipal(request),
          kind,
          idempotencyKey: metadata.idempotencyKey,
          bytes,
        });
        reply.header("cache-control", "no-store");
        return reply.code(201).send(resource);
      };

    for (const [path, kind, operationId, summary] of [
      [
        "/v2/media/avatars",
        "avatar",
        "uploadV2Avatar",
        "Upload an avatar picture",
      ],
      [
        "/v2/media/community-logos",
        "community_logo",
        "uploadV2CommunityLogo",
        "Upload a community logo picture",
      ],
    ] as const) {
      scope.post(
        path,
        {
          schema: {
            operationId,
            summary,
            description: `multipart/form-data with one part \`file\` (Decision 0095). The picture is sniffed by content (JPEG/PNG/WebP/HEIC), must be <= 5 MiB with both sides >= 64 px, and is stored as a 512x512 cover WebP (quality 82, metadata stripped). 422 VALIDATION_FAILED carries detailsSafe.reasonCode MEDIA_TYPE_UNSUPPORTED | MEDIA_TOO_LARGE | MEDIA_DIMENSIONS_TOO_SMALL | MEDIA_DECODE_FAILED (HEVC-coded HEIC is not decodable: send JPEG). Idempotency-Key replays the stored object for the same bytes and conflicts for different bytes. Six uploads per user per minute across both upload routes (429 RATE_LIMITED). ${kind === "avatar" ? "Write the returned ref into avatarRef via PUT /v2/profile or POST /v2/profile/loop-id." : "Write the returned ref into logoRef via POST /v2/communities or PATCH /v2/communities/{communityId}; it is accepted when the uploader is the caller (create) or a current owner/admin (update)."}`,
            tags: ["profile"],
            security: [{ privyBearer: [] }],
            consumes: ["multipart/form-data"],
            headers: v2CommandHeadersSchema,
            querystring: emptyQueryStringSchema,
            body: uploadBodySchema,
            response: { 201: uploadResponseSchema, ...uploadErrors },
          },
          onRequest: validateCommandHeaders,
          preValidation: prepareMultipartBody,
          preHandler: authenticateLoopBearer,
        },
        upload(kind),
      );
    }

    // Decision 0173: the project NFT picture — the community-logo rules,
    // plus an IPFS pin (Filebase) when NFT_IMAGE_STORAGE=filebase.
    scope.post(
      "/v2/media/project-nft-images",
      {
        schema: {
          operationId: "uploadV2ProjectNftImage",
          summary: "Upload a MEME v2 project NFT picture",
          description: `Decision 0173. multipart/form-data with one part \`file\`, the community-logo rules (Decision 0095): sniffed by content (JPEG/PNG/WebP/HEIC), <= 5 MiB, both sides >= 64 px, stored as a 512x512 cover WebP (quality 82, metadata stripped; a square picture is recommended). With NFT_IMAGE_STORAGE=filebase the stored WebP is also pinned to IPFS through Filebase before it is saved: \`cid\` / \`ipfsUri\` name the pin and \`url\` is the public gateway URL \`<IPFS_GATEWAY_BASE_URL>/<cid>\`; otherwise (local) \`cid\` / \`ipfsUri\` are null and \`url\` is the API-relative media path like the other uploads. \`mediaUrl\` is always the API-relative local copy (GET /v2/media/{mediaId}.webp), a fallback. Put \`url\` (absolute: prefix the API base URL when it is relative) into the Hooks launch draft's \`nftImageAssetUrl\`; the draft save accepts only the caller's own upload (422 VALIDATION_FAILED MEDIA_NOT_OWNED). 503 CAPABILITY_UNAVAILABLE / ${mediaIpfsUnavailableReason} when the pin fails (nothing is stored; retry with the same Idempotency-Key). 422 reason codes, idempotency and the shared six-per-minute limit as the other upload routes.`,
          tags: ["profile"],
          security: [{ privyBearer: [] }],
          consumes: ["multipart/form-data"],
          headers: v2CommandHeadersSchema,
          querystring: emptyQueryStringSchema,
          body: uploadBodySchema,
          response: { 201: nftUploadResponseSchema, ...uploadErrors },
        },
        onRequest: validateCommandHeaders,
        preValidation: prepareMultipartBody,
        preHandler: authenticateLoopBearer,
      },
      upload("project_nft_image"),
    );
  });

  app.get(
    "/v2/media/:mediaId.webp",
    {
      schema: {
        operationId: "getV2Media",
        summary: "Get an uploaded avatar or community logo",
        description:
          "Public immutable image resource (Decision 0095); no authentication and no LOOP headers, like the token logo proxy. 200 image/webp with `Cache-Control: public, max-age=31536000, immutable` and a strong ETag; `If-None-Match` answers 304; an unknown ID is 404 NOT_FOUND. Decision 0157: `Cross-Origin-Resource-Policy: cross-origin`, so any web origin may embed it.",
        tags: ["profile"],
        security: [],
        params: {
          type: "object",
          additionalProperties: false,
          required: ["mediaId"],
          properties: {
            mediaId: { type: "string", pattern: mediaIdPatternSource },
          },
        },
        querystring: emptyQueryStringSchema,
        response: {
          200: {
            description:
              "The WebP bytes. `Cache-Control: public, max-age=31536000, immutable`, `ETag`, `X-Content-Type-Options: nosniff`.",
            content: {
              "image/webp": { schema: { type: "string", format: "binary" } },
            },
          },
          304: {
            description: "`If-None-Match` matched the `ETag`.",
            type: "null",
          },
          ...readErrors,
        },
      },
      preValidation: assertNoBodyOrQuery,
    },
    async (request, reply) => {
      const { mediaId } = request.params as { readonly mediaId: string };
      const media = await mediaService.read(mediaId);
      if (media === null) {
        throw V2ApiError.notFound();
      }
      reply.header("cache-control", mediaCacheControl);
      reply.header("etag", media.etag);
      reply.header("x-content-type-options", "nosniff");
      // Decision 0157: helmet's default `same-origin` would make browsers
      // refuse these public images on other origins (the public MEME page).
      reply.header("cross-origin-resource-policy", "cross-origin");
      if (ifNoneMatchSatisfied(request.headers["if-none-match"], media.etag)) {
        return reply.code(304).send();
      }
      reply.header("content-type", media.contentType);
      return reply.code(200).send(media.bytes);
    },
  );
}
