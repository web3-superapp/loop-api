import type {
  FastifyInstance,
  FastifyRequest,
  preHandlerAsyncHookHandler,
} from "fastify";

import { requireAuthenticatedLoopPrincipal } from "../../core/http/authentication.js";
import {
  emptyQueryStringSchema,
  noStoreResponseHeaders,
} from "../../core/http/schemas.js";
import { v2ErrorResponseSchema } from "../../core/http/v2-error.js";
import { parseV2CommandMetadata } from "../../features/community/community-contract.js";
import { v2ContractVersion } from "../../features/meta/product-policy.js";
import {
  squareFeedScopes,
  squareLimits,
  squarePostKinds,
  squareReasonCodes,
  squareTokenKinds,
} from "../../features/square/square-contract.js";
import type { SquareService } from "../../features/square/square-service.js";
import {
  assertNoBodyOrQueryV2,
  assertNoBodyV2,
  assertNoQuery,
  cursorSchema,
  identityProjectionSchema,
  nullableCursorSchema,
  v2CommandHeadersSchema,
  v2CommonHeadersSchema,
  validateCommandHeaders,
  validateCommonHeaders,
} from "./community-schemas.js";

/**
 * Decision 0143: the square「动态」timeline. Always registered (not a
 * `V2_MODULES_ENABLED` module); capability `squareFeed`. Without the
 * database (or the cursor secret) every route is 503
 * CAPABILITY_UNAVAILABLE / SQUARE_REPOSITORY_UNAVAILABLE.
 */

const uuidSchema = {
  type: "string",
  pattern:
    "^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$",
} as const;
const nullableUuidSchema = { anyOf: [uuidSchema, { type: "null" }] } as const;
const decimalSchema = {
  type: "string",
  pattern: "^-?(0|[1-9][0-9]*)(\\.[0-9]+)?$",
} as const;
const nullableDecimalSchema = {
  anyOf: [decimalSchema, { type: "null" }],
} as const;
const dateTimeSchema = { type: "string", format: "date-time" } as const;

const tokenQuoteSchema = {
  type: "object",
  additionalProperties: false,
  required: [
    "kind",
    "memeTokenId",
    "instanceId",
    "symbol",
    "logoUrl",
    "priceUsd1",
    "change1hPct",
    "marketCapUsd1",
  ],
  description:
    "The quote line. kind meme: a MEME v1 token (memeTokenId; curve price, 1 h change, cap; null after graduation). kind launch2: a MEME v2 instance (instanceId; curve price, or the newest official-pool price after graduation with the 1 h change against the pool price an hour ago; cap = price × 1e9). Read-model values only; any value it cannot read is null. USD1 at par.",
  properties: {
    kind: { type: "string", enum: [...squareTokenKinds] },
    memeTokenId: nullableUuidSchema,
    instanceId: nullableUuidSchema,
    symbol: { type: "string", minLength: 1, maxLength: 16 },
    logoUrl: {
      anyOf: [{ type: "string", maxLength: 2048 }, { type: "null" }],
    },
    priceUsd1: nullableDecimalSchema,
    change1hPct: nullableDecimalSchema,
    marketCapUsd1: nullableDecimalSchema,
  },
} as const;

const eventSchema = {
  anyOf: [
    {
      type: "object",
      additionalProperties: {
        anyOf: [{ type: "string", maxLength: 200 }, { type: "null" }],
      },
      description:
        "Facts of a system-event post (the App renders the text). buy: amountUsd1 (stable quote paid), tokenAmount, transactionHash. claim: amountUsd1, roundId, weightPct (the wallet's share of the round's buy weight, two decimals, or null), transactionHash. graduation: transactionHash (or null).",
    },
    { type: "null" },
  ],
} as const;

export const squareFeedItemSchema = {
  type: "object",
  additionalProperties: false,
  required: [
    "postId",
    "kind",
    "author",
    "text",
    "token",
    "event",
    "likeCount",
    "likedByViewer",
    "pinned",
    "createdAt",
  ],
  properties: {
    postId: uuidSchema,
    kind: {
      type: "string",
      enum: [...squarePostKinds],
      description:
        "opinion = a user's post; buy / claim / graduation = system events (author = the user behind the event); system = an official console post (author null, may be pinned).",
    },
    author: {
      anyOf: [identityProjectionSchema, { type: "null" }],
      description: "null only for kind system (LOOP official).",
    },
    text: {
      anyOf: [
        { type: "string", minLength: 1, maxLength: squareLimits.textMax },
        { type: "null" },
      ],
      description: "opinion / system text; null for event kinds.",
    },
    token: {
      anyOf: [tokenQuoteSchema, { type: "null" }],
      description:
        "null when the post names no token or the referenced token is no longer readable.",
    },
    event: eventSchema,
    likeCount: { type: "integer", minimum: 0 },
    likedByViewer: { type: "boolean" },
    pinned: { type: "boolean" },
    createdAt: {
      ...dateTimeSchema,
      description:
        "Timeline time: publish time (opinion / system), event time (buy / claim / graduation).",
    },
  },
} as const;

const feedResourceSchema = {
  type: "object",
  headers: noStoreResponseHeaders(),
  additionalProperties: false,
  required: ["scope", "items", "nextCursor", "observedAt", "contractVersion"],
  properties: {
    scope: { type: "string", enum: [...squareFeedScopes] },
    items: {
      type: "array",
      maxItems: squareLimits.feedMax + squareLimits.pinnedMax,
      items: squareFeedItemSchema,
    },
    nextCursor: nullableCursorSchema,
    observedAt: dateTimeSchema,
    contractVersion: { type: "string", const: v2ContractVersion },
  },
} as const;

const postResourceSchema = {
  type: "object",
  headers: noStoreResponseHeaders(),
  additionalProperties: false,
  required: ["post", "contractVersion"],
  properties: {
    post: squareFeedItemSchema,
    contractVersion: { type: "string", const: v2ContractVersion },
  },
} as const;

const likeResourceSchema = {
  type: "object",
  headers: noStoreResponseHeaders(),
  additionalProperties: false,
  required: ["postId", "likeCount", "likedByViewer", "contractVersion"],
  properties: {
    postId: uuidSchema,
    likeCount: { type: "integer", minimum: 0 },
    likedByViewer: { type: "boolean" },
    contractVersion: { type: "string", const: v2ContractVersion },
  },
} as const;

const feedQuerySchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    scope: {
      type: "string",
      enum: [...squareFeedScopes],
      description:
        "global (default) = every visible post; following = posts of the accounts the caller follows. Bound into the cursor: send the same scope with a cursor.",
    },
    cursor: cursorSchema,
    limit: { type: "integer", minimum: 1, maximum: squareLimits.feedMax },
  },
} as const;

const createBodySchema = {
  type: "object",
  additionalProperties: false,
  required: ["text"],
  properties: {
    text: {
      type: "string",
      description: `1–${String(squareLimits.textMax)} characters after trim (line feeds allowed; control, separator and bidi override characters refused).`,
    },
    tokenRef: {
      // null first: the coercing validator would turn null into "".
      anyOf: [
        { type: "null" },
        {
          type: "object",
          additionalProperties: false,
          required: ["kind", "id"],
          properties: {
            kind: { type: "string", enum: [...squareTokenKinds] },
            id: { type: "string" },
          },
        },
      ],
      description:
        "Optional token the post is about: {kind: meme, id: memeTokenId} (an on-chain MEME v1 token) or {kind: launch2, id: instanceId}. Unknown → 422 SQUARE_TOKEN_REF_INVALID.",
    },
  },
} as const;

const postParamsSchema = {
  type: "object",
  additionalProperties: false,
  required: ["postId"],
  properties: { postId: { type: "string", maxLength: 64 } },
} as const;

const readErrors = {
  400: v2ErrorResponseSchema(["INVALID_REQUEST"]),
  401: v2ErrorResponseSchema(["AUTH_REQUIRED", "AUTH_INVALID"], {
    includeBearerChallenge: true,
  }),
  404: v2ErrorResponseSchema(["NOT_FOUND"]),
  409: v2ErrorResponseSchema([
    "ACCOUNT_BOOTSTRAP_REQUIRED",
    "VERSION_CONFLICT",
  ]),
  500: v2ErrorResponseSchema(["INTERNAL_ERROR"]),
  503: v2ErrorResponseSchema([
    "CAPABILITY_UNAVAILABLE",
    "PROVIDER_DISCONNECTED",
    "REQUEST_TIMEOUT",
  ]),
} as const;

const commandErrors = {
  ...readErrors,
  409: v2ErrorResponseSchema([
    "ACCOUNT_BOOTSTRAP_REQUIRED",
    "IDEMPOTENCY_CONFLICT",
    "PROFILE_ACTIVATION_REQUIRED",
    "VERSION_CONFLICT",
  ]),
  422: v2ErrorResponseSchema(["VALIDATION_FAILED"]),
  429: v2ErrorResponseSchema(["RATE_LIMITED"]),
} as const;

const unavailableNote =
  "Without the database or the cursor secret: 503 CAPABILITY_UNAVAILABLE / SQUARE_REPOSITORY_UNAVAILABLE (never an empty list).";

function idempotencyKey(request: FastifyRequest): string {
  return parseV2CommandMetadata(request.raw.rawHeaders).idempotencyKey;
}

export function registerV2SquareRoutes(
  app: FastifyInstance,
  authenticateLoopBearer: preHandlerAsyncHookHandler,
  service: SquareService,
): void {
  app.get(
    "/v2/square/feed",
    {
      schema: {
        operationId: "getV2SquareFeed",
        summary: "Square timeline (动态)",
        description: `Decision 0143. Newest first (createdAt, then postId). The first page (no cursor) starts with up to ${String(squareLimits.pinnedMax)} pinned official posts (newest first, in both scopes); later pages never repeat them. limit ≤ ${String(squareLimits.feedMax)} (default ${String(squareLimits.feedDefault)}); cursor and limit are mutually exclusive (the cursor carries the size and is bound to the caller and scope). A user post is shown while its author has an active profile and neither side blocked the other. likedByViewer is the caller's like. ${unavailableNote}`,
        tags: ["square"],
        security: [{ privyBearer: [] }],
        headers: v2CommonHeadersSchema,
        querystring: feedQuerySchema,
        response: { 200: feedResourceSchema, ...readErrors },
      },
      onRequest: validateCommonHeaders,
      preValidation: assertNoBodyV2,
      preHandler: authenticateLoopBearer,
    },
    async (request, reply) => {
      const query = request.query as Record<string, unknown>;
      const resource = await service.getFeed({
        principal: requireAuthenticatedLoopPrincipal(request),
        scope: query["scope"],
        cursor: query["cursor"],
        limit: query["limit"],
      });
      reply.header("cache-control", "no-store");
      return reply.code(200).send(resource);
    },
  );

  app.post(
    "/v2/square/posts",
    {
      schema: {
        operationId: "createV2SquarePost",
        summary: "Post an opinion to the square",
        description: `Decision 0143. kind is always opinion, published at once. Idempotency-Key (UUIDv4, required): the same key and body replays the first post (200), another body is 409 IDEMPOTENCY_CONFLICT; first write 201. More than ${String(squareLimits.postsPerMinute)} posts in a rolling minute: 429 RATE_LIMITED (${squareReasonCodes.rateLimited}). 422 VALIDATION_FAILED with detailsSafe.reasonCode + field: ${squareReasonCodes.textEmpty}, ${squareReasonCodes.textTooLong} (> ${String(squareLimits.textMax)} characters), ${squareReasonCodes.textInvalid}, ${squareReasonCodes.tokenRefInvalid}. Without an activated profile: 409 PROFILE_ACTIVATION_REQUIRED. ${unavailableNote}`,
        tags: ["square"],
        security: [{ privyBearer: [] }],
        headers: v2CommandHeadersSchema,
        querystring: emptyQueryStringSchema,
        body: createBodySchema,
        response: {
          200: postResourceSchema,
          201: postResourceSchema,
          ...commandErrors,
        },
      },
      onRequest: validateCommandHeaders,
      preValidation: assertNoQuery,
      preHandler: authenticateLoopBearer,
    },
    async (request, reply) => {
      const created = await service.createPost({
        principal: requireAuthenticatedLoopPrincipal(request),
        idempotencyKey: idempotencyKey(request),
        body: request.body,
      });
      reply.header("cache-control", "no-store");
      return reply.code(created.replayed ? 200 : 201).send(created.resource);
    },
  );

  app.delete(
    "/v2/square/posts/:postId",
    {
      schema: {
        operationId: "deleteV2SquarePost",
        summary: "Delete one of the caller's square posts",
        description: `Decision 0143. Archives the caller's own opinion (gone from every timeline; likes kept). Already deleted: 204 again. Another account's post, an event or official post, or an unknown id: 404 NOT_FOUND. ${unavailableNote}`,
        tags: ["square"],
        security: [{ privyBearer: [] }],
        headers: v2CommandHeadersSchema,
        params: postParamsSchema,
        querystring: emptyQueryStringSchema,
        response: {
          204: { type: "null", headers: noStoreResponseHeaders() },
          ...commandErrors,
        },
      },
      onRequest: validateCommandHeaders,
      preValidation: assertNoBodyOrQueryV2,
      preHandler: authenticateLoopBearer,
    },
    async (request, reply) => {
      const { postId } = request.params as { readonly postId: string };
      await service.deletePost({
        principal: requireAuthenticatedLoopPrincipal(request),
        postId,
      });
      reply.header("cache-control", "no-store");
      return reply.code(204).send();
    },
  );

  for (const [method, liked, operationId, summary] of [
    ["PUT", true, "likeV2SquarePost", "Like a square post"],
    ["DELETE", false, "unlikeV2SquarePost", "Remove the caller's like"],
  ] as const) {
    app.route({
      method,
      url: "/v2/square/posts/:postId/like",
      schema: {
        operationId,
        summary,
        description: `Decision 0143. Idempotent: liking twice keeps one like, removing a missing like succeeds. Answers the post's like count after the write. A post that is not published (unknown, deleted, archived): 404 NOT_FOUND. Idempotency-Key is required like every square write; the like itself is the dedupe. ${unavailableNote}`,
        tags: ["square"],
        security: [{ privyBearer: [] }],
        headers: v2CommandHeadersSchema,
        params: postParamsSchema,
        querystring: emptyQueryStringSchema,
        response: { 200: likeResourceSchema, ...commandErrors },
      },
      onRequest: validateCommandHeaders,
      preValidation: assertNoBodyOrQueryV2,
      preHandler: authenticateLoopBearer,
      handler: async (request, reply) => {
        const { postId } = request.params as { readonly postId: string };
        const resource = await service.setLike({
          principal: requireAuthenticatedLoopPrincipal(request),
          postId,
          liked,
        });
        reply.header("cache-control", "no-store");
        return reply.code(200).send(resource);
      },
    });
  }
}
