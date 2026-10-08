import type { FastifyInstance, FastifyRequest } from "fastify";

import { requireAuthenticatedLoopPrincipal } from "../../core/http/authentication.js";
import { emptyQueryStringSchema } from "../../core/http/schemas.js";
import { V2ApiError, v2ErrorResponseSchema } from "../../core/http/v2-error.js";
import {
  opaqueIdPatternSource,
  parseV2CommandMetadata,
  storedAvatarRefPatternSource,
} from "../../features/community/community-contract.js";
import {
  isLoopId,
  loopIdPatternSource,
} from "../../features/identity/loop-id.js";
import { v2ContractVersion } from "../../features/meta/product-policy.js";
import { friendshipStates } from "../../features/profile/public-profile-repository.js";
import { profileTradeLimits } from "../../features/profile/public-profile-service.js";
import {
  assertNoBodyOrQueryV2,
  assertNoBodyV2,
  commandErrors,
  communitySummarySchema,
  publicProfileIdParamsSchema,
  v2CommandHeadersSchema,
  v2CommonHeadersSchema,
  validateCommandHeaders,
  validateCommonHeaders,
} from "./community-schemas.js";
import type { V2RouteDependencies } from "./index.js";

/**
 * Public profiles, friend removal, and recommended communities (Decision
 * 0095). Registered with the `community` module, next to the social graph.
 */

const nullableText = {
  anyOf: [{ type: "string", minLength: 1, maxLength: 1024 }, { type: "null" }],
} as const;
const nullableDateTime = {
  anyOf: [{ type: "string", format: "date-time" }, { type: "null" }],
} as const;
const statusSchema = {
  type: "string",
  enum: ["available", "hidden", "unavailable"],
  description:
    "`hidden`: the owner switched this off (privacy visibility `self`); `unavailable`: no fact can be read (see reasonCode). Never a zero substitute.",
} as const;
const reasonCodeSchema = {
  anyOf: [
    {
      type: "string",
      enum: [
        "WALLET_NOT_BOUND",
        "BSC_READ_UNAVAILABLE",
        "WALLET_RUNTIME_UNAVAILABLE",
        "BSC_INDEXER_NOT_STARTED",
        "V2_CURSOR_NOT_CONFIGURED",
      ],
    },
    { type: "null" },
  ],
  description: "Set only when status is `unavailable`.",
} as const;
const decimalString = {
  type: "string",
  pattern: "^[0-9]+(\\.[0-9]+)?$",
} as const;
const nullableDecimal = { anyOf: [decimalString, { type: "null" }] } as const;

const profileResourceSchema = {
  type: "object",
  additionalProperties: false,
  required: [
    "publicProfileId",
    "loopId",
    "alias",
    "avatarRef",
    "bio",
    "joinedAt",
    "counts",
    "relationship",
    "visibility",
    "contractVersion",
  ],
  properties: {
    publicProfileId: { type: "string", pattern: opaqueIdPatternSource },
    loopId: { type: "string", pattern: loopIdPatternSource },
    alias: nullableText,
    avatarRef: {
      anyOf: [
        { type: "string", pattern: storedAvatarRefPatternSource },
        { type: "null" },
      ],
      description:
        "`avatar:media/{mediaId}` renders `{baseUrl}/v2/media/{mediaId}.webp`; `avatar:preset/*` keeps the preset rendering.",
    },
    bio: nullableText,
    joinedAt: nullableDateTime,
    counts: {
      type: "object",
      additionalProperties: false,
      required: ["followers", "following", "communities"],
      properties: {
        followers: { type: "integer", minimum: 0 },
        following: { type: "integer", minimum: 0 },
        communities: {
          type: "integer",
          minimum: 0,
          description: "Non-banned memberships of verified communities.",
        },
      },
    },
    relationship: {
      type: "object",
      additionalProperties: false,
      required: [
        "following",
        "followedBy",
        "friendship",
        "blocked",
        "blockedBy",
      ],
      properties: {
        following: { type: "boolean" },
        followedBy: { type: "boolean" },
        friendship: { type: "string", enum: [...friendshipStates] },
        blocked: { type: "boolean", description: "The viewer blocked them." },
        blockedBy: {
          type: "boolean",
          description:
            "Always false: a profile whose owner blocked the viewer is 404 PROFILE_NOT_FOUND.",
        },
      },
    },
    visibility: {
      type: "object",
      additionalProperties: false,
      required: ["holdings", "trades"],
      properties: {
        holdings: { type: "boolean" },
        trades: { type: "boolean" },
      },
    },
    contractVersion: { type: "string", const: v2ContractVersion },
  },
} as const;

const holdingsResourceSchema = {
  type: "object",
  additionalProperties: false,
  required: [
    "status",
    "reasonCode",
    "totalUsd",
    "items",
    "observedAt",
    "contractVersion",
  ],
  properties: {
    status: statusSchema,
    reasonCode: reasonCodeSchema,
    totalUsd: {
      ...nullableDecimal,
      description:
        "Sum of the listed usdValue; null when any listed row has no price or status is not available.",
    },
    items: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: [
          "assetId",
          "symbol",
          "name",
          "logoUrl",
          "balance",
          "usdValue",
        ],
        properties: {
          assetId: { type: "string", minLength: 1, maxLength: 128 },
          symbol: { type: "string", minLength: 1, maxLength: 32 },
          name: { type: "string", minLength: 1, maxLength: 128 },
          logoUrl: {
            anyOf: [{ type: "string", minLength: 1 }, { type: "null" }],
          },
          balance: decimalString,
          usdValue: nullableDecimal,
        },
      },
    },
    observedAt: nullableDateTime,
    contractVersion: { type: "string", const: v2ContractVersion },
  },
} as const;

const tradesResourceSchema = {
  type: "object",
  additionalProperties: false,
  required: ["status", "reasonCode", "items", "nextCursor", "contractVersion"],
  properties: {
    status: statusSchema,
    reasonCode: reasonCodeSchema,
    items: {
      type: "array",
      maxItems: profileTradeLimits.maximum,
      items: {
        type: "object",
        additionalProperties: false,
        required: [
          "eventId",
          "kind",
          "assetId",
          "symbol",
          "amount",
          "usdValue",
          "blockTimestamp",
          "blockNumber",
          "txHash",
        ],
        properties: {
          eventId: { type: "string", pattern: opaqueIdPatternSource },
          kind: {
            type: "string",
            enum: ["buy", "sell", "transfer_in", "transfer_out"],
          },
          assetId: { type: "string", minLength: 1, maxLength: 128 },
          symbol: { type: "string", minLength: 1, maxLength: 32 },
          amount: decimalString,
          usdValue: nullableDecimal,
          blockTimestamp: {
            ...nullableDateTime,
            description:
              "Block time; null for a transfer whose block has no indexed pool event.",
          },
          blockNumber: { type: "string", pattern: "^[0-9]{1,20}$" },
          txHash: { type: "string", pattern: "^0x[0-9a-f]{64}$" },
        },
      },
    },
    nextCursor: {
      anyOf: [
        { type: "string", minLength: 1, maxLength: 1536 },
        { type: "null" },
      ],
    },
    contractVersion: { type: "string", const: v2ContractVersion },
  },
} as const;

const removeFriendResourceSchema = {
  type: "object",
  additionalProperties: false,
  required: ["publicProfileId", "friendship", "removed", "contractVersion"],
  properties: {
    publicProfileId: { type: "string", pattern: opaqueIdPatternSource },
    friendship: { type: "string", const: "none" },
    removed: {
      type: "boolean",
      description: "False when no friendship existed (idempotent success).",
    },
    contractVersion: { type: "string", const: v2ContractVersion },
  },
} as const;

const recommendedResourceSchema = {
  type: "object",
  additionalProperties: false,
  required: ["items", "defaultSelectedIds", "contractVersion"],
  properties: {
    items: { type: "array", maxItems: 50, items: communitySummarySchema },
    defaultSelectedIds: {
      type: "array",
      maxItems: 5,
      items: { type: "string", pattern: opaqueIdPatternSource },
    },
    contractVersion: { type: "string", const: v2ContractVersion },
  },
} as const;

const profileReadErrors = {
  400: v2ErrorResponseSchema(["INVALID_REQUEST"]),
  401: v2ErrorResponseSchema(["AUTH_REQUIRED", "AUTH_INVALID"], {
    includeBearerChallenge: true,
  }),
  404: v2ErrorResponseSchema(["PROFILE_NOT_FOUND"]),
  409: v2ErrorResponseSchema(["ACCOUNT_BOOTSTRAP_REQUIRED"]),
  500: v2ErrorResponseSchema(["INTERNAL_ERROR"]),
  503: v2ErrorResponseSchema([
    "CAPABILITY_UNAVAILABLE",
    "PROVIDER_DISCONNECTED",
    "REQUEST_TIMEOUT",
  ]),
} as const;

const recommendedErrors = {
  400: v2ErrorResponseSchema(["INVALID_REQUEST"]),
  401: v2ErrorResponseSchema(["AUTH_REQUIRED", "AUTH_INVALID"], {
    includeBearerChallenge: true,
  }),
  409: v2ErrorResponseSchema(["ACCOUNT_BOOTSTRAP_REQUIRED"]),
  500: v2ErrorResponseSchema(["INTERNAL_ERROR"]),
  503: v2ErrorResponseSchema([
    "CAPABILITY_UNAVAILABLE",
    "PROVIDER_DISCONNECTED",
    "REQUEST_TIMEOUT",
  ]),
} as const;

const tradesQuerySchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    cursor: { type: "string", minLength: 1, maxLength: 1536 },
    limit: {
      type: "integer",
      minimum: 1,
      maximum: profileTradeLimits.maximum,
      default: profileTradeLimits.default,
    },
  },
} as const;

const loopIdParamsSchema = {
  type: "object",
  additionalProperties: false,
  required: ["loopId"],
  properties: {
    loopId: {
      type: "string",
      pattern: "^[Ll][Oo][Oo][Pp]-[0-9A-Za-z]{8}$",
      description:
        "Case-insensitive LOOP ID. A well-formed ID that names nobody is 404 PROFILE_NOT_FOUND.",
    },
  },
} as const;

const profileReadDescription =
  "Bearer read of another account's public profile (Decision 0095). Not found, not activated, and blocked-by-the-target all return the same 404 PROFILE_NOT_FOUND. `discoverable` is not consulted. Viewing yourself is allowed.";

function signalOf(request: FastifyRequest): AbortSignal {
  const controller = new AbortController();
  request.raw.once("close", () => {
    if (!request.raw.complete) {
      controller.abort();
    }
  });
  return controller.signal;
}

export function registerV2PublicProfileRoutes(
  app: FastifyInstance,
  dependencies: V2RouteDependencies,
): void {
  const { authenticateLoopBearer, publicProfileService: service } =
    dependencies;

  app.get(
    "/v2/profiles/:publicProfileId",
    {
      schema: {
        operationId: "getV2PublicProfile",
        summary: "Get another account's public profile",
        description: profileReadDescription,
        tags: ["social"],
        security: [{ privyBearer: [] }],
        headers: v2CommonHeadersSchema,
        params: publicProfileIdParamsSchema,
        querystring: emptyQueryStringSchema,
        response: { 200: profileResourceSchema, ...profileReadErrors },
      },
      onRequest: validateCommonHeaders,
      preValidation: assertNoBodyOrQueryV2,
      preHandler: authenticateLoopBearer,
    },
    async (request, reply) => {
      const { publicProfileId } = request.params as {
        readonly publicProfileId: string;
      };
      const resource = await service.getProfile({
        principal: requireAuthenticatedLoopPrincipal(request),
        lookup: { publicProfileId },
      });
      reply.header("cache-control", "no-store");
      return reply.code(200).send(resource);
    },
  );

  app.get(
    "/v2/profiles/by-loop-id/:loopId",
    {
      schema: {
        operationId: "getV2PublicProfileByLoopId",
        summary: "Get a public profile by LOOP ID",
        description: `${profileReadDescription} Used by the \`/u/{loopId}\` deep link.`,
        tags: ["social"],
        security: [{ privyBearer: [] }],
        headers: v2CommonHeadersSchema,
        params: loopIdParamsSchema,
        querystring: emptyQueryStringSchema,
        response: { 200: profileResourceSchema, ...profileReadErrors },
      },
      onRequest: validateCommonHeaders,
      preValidation: assertNoBodyOrQueryV2,
      preHandler: authenticateLoopBearer,
    },
    async (request, reply) => {
      const { loopId } = request.params as { readonly loopId: string };
      const normalized = loopId.toUpperCase();
      if (!isLoopId(normalized)) {
        throw V2ApiError.fromCode("PROFILE_NOT_FOUND");
      }
      const resource = await service.getProfile({
        principal: requireAuthenticatedLoopPrincipal(request),
        lookup: { loopId: normalized },
      });
      reply.header("cache-control", "no-store");
      return reply.code(200).send(resource);
    },
  );

  app.get(
    "/v2/profiles/:publicProfileId/holdings",
    {
      schema: {
        operationId: "getV2PublicProfileHoldings",
        summary: "Get a public profile's token holdings",
        description:
          "The owner's selected active wallet read on chain through the wallet balance service (one block, registry assets, zero rows omitted). `hidden` when the owner's privacy `visibility.totalAssets` is `self` (the owner always sees their own). `unavailable` with a reasonCode when no wallet is bound or the chain cannot be read; never a zero. No address is published.",
        tags: ["social"],
        security: [{ privyBearer: [] }],
        headers: v2CommonHeadersSchema,
        params: publicProfileIdParamsSchema,
        querystring: emptyQueryStringSchema,
        response: { 200: holdingsResourceSchema, ...profileReadErrors },
      },
      onRequest: validateCommonHeaders,
      preValidation: assertNoBodyOrQueryV2,
      preHandler: authenticateLoopBearer,
    },
    async (request, reply) => {
      const { publicProfileId } = request.params as {
        readonly publicProfileId: string;
      };
      const resource = await service.getHoldings({
        principal: requireAuthenticatedLoopPrincipal(request),
        publicProfileId,
        signal: signalOf(request),
      });
      reply.header("cache-control", "no-store");
      return reply.code(200).send(resource);
    },
  );

  app.get(
    "/v2/profiles/:publicProfileId/trades",
    {
      schema: {
        operationId: "listV2PublicProfileTrades",
        summary: "List a public profile's trades and transfers",
        description:
          "Indexed swaps and registry-asset transfers of the owner's selected active wallet, newest first (Decision 0095 §3 kind rules: a swap whose recipient or sender is the wallet is buy/sell of the non-quote token; other transfers are transfer_in/transfer_out). `hidden` when `visibility.tradeHistory` is `self`. Opaque cursor bound to the viewer and the profile.",
        tags: ["social"],
        security: [{ privyBearer: [] }],
        headers: v2CommonHeadersSchema,
        params: publicProfileIdParamsSchema,
        querystring: tradesQuerySchema,
        response: { 200: tradesResourceSchema, ...profileReadErrors },
      },
      onRequest: validateCommonHeaders,
      preValidation: assertNoBodyV2,
      preHandler: authenticateLoopBearer,
    },
    async (request, reply) => {
      const { publicProfileId } = request.params as {
        readonly publicProfileId: string;
      };
      const query = request.query as {
        readonly cursor?: unknown;
        readonly limit?: unknown;
      };
      const resource = await service.getTrades({
        principal: requireAuthenticatedLoopPrincipal(request),
        publicProfileId,
        cursor: query.cursor,
        limit: query.limit,
      });
      reply.header("cache-control", "no-store");
      return reply.code(200).send(resource);
    },
  );

  app.delete(
    "/v2/friends/:publicProfileId",
    {
      schema: {
        operationId: "removeV2Friend",
        summary: "Remove a friend",
        description:
          "Deletes the accepted friendship of the pair (the frozen V1 `friendships` storage) and writes one `friendship_removed` audit row. Idempotent: without a friendship it succeeds with `removed: false`. Replaying the Idempotency-Key returns the first result; the same key for another target is IDEMPOTENCY_CONFLICT. A nonexistent, unactivated, or self target is NOT_FOUND; a block does not prevent removal. Follow edges and request history are untouched.",
        tags: ["social"],
        security: [{ privyBearer: [] }],
        headers: v2CommandHeadersSchema,
        params: publicProfileIdParamsSchema,
        querystring: emptyQueryStringSchema,
        response: { 200: removeFriendResourceSchema, ...commandErrors },
      },
      onRequest: validateCommandHeaders,
      preValidation: assertNoBodyOrQueryV2,
      preHandler: authenticateLoopBearer,
    },
    async (request, reply) => {
      const { publicProfileId } = request.params as {
        readonly publicProfileId: string;
      };
      const resource = await service.removeFriend({
        principal: requireAuthenticatedLoopPrincipal(request),
        publicProfileId,
        idempotencyKey: parseV2CommandMetadata(request.raw.rawHeaders)
          .idempotencyKey,
        requestId: request.id,
      });
      reply.header("cache-control", "no-store");
      return reply.code(200).send(resource);
    },
  );

  app.get(
    "/v2/communities/recommended",
    {
      schema: {
        operationId: "listV2RecommendedCommunities",
        summary: "List the communities recommended after registration",
        description:
          "Verified communities from the operator list, in configured order (Decision 0095). Decision 0102: the operator console's saved list wins; without one, RECOMMENDED_COMMUNITY_IDS is in force. `defaultSelectedIds` are the first five listed. An unset list is an empty result, not an error.",
        tags: ["community"],
        security: [{ privyBearer: [] }],
        headers: v2CommonHeadersSchema,
        querystring: emptyQueryStringSchema,
        response: { 200: recommendedResourceSchema, ...recommendedErrors },
      },
      onRequest: validateCommonHeaders,
      preValidation: assertNoBodyOrQueryV2,
      preHandler: authenticateLoopBearer,
    },
    async (request, reply) => {
      const resource = await service.listRecommendedCommunities({
        principal: requireAuthenticatedLoopPrincipal(request),
      });
      reply.header("cache-control", "no-store");
      return reply.code(200).send(resource);
    },
  );
}
