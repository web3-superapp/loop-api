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
import { launch2Stages } from "../../features/launch2/launch2-contract.js";
import { v2ContractVersion } from "../../features/meta/product-policy.js";
import { chainIdPatternSource } from "../../features/chain/chain-contract.js";
import { profileLaunch2HoldingKinds } from "../../features/profile/profile-launch2.js";
import { friendshipStates } from "../../features/profile/public-profile-repository.js";
import {
  profileCommunitiesHiddenReasonCode,
  profileCommunityLimits,
  profileTradeLimits,
} from "../../features/profile/public-profile-service.js";
import {
  blockNumberSchema,
  launch2DecimalSchema,
  unavailableSchema,
  walletActivityLaunch2ItemSchema,
} from "./chain-schemas.js";
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

/**
 * Decision 0169: the optional `launch2` block (the Decision 0167 shapes),
 * sent only with PROFILE_LAUNCH2_EMIT=on.
 */
function launch2BlockSchema(reasons: string) {
  return {
    description: `Decision 0169: OPTIONAL key — present only with PROFILE_LAUNCH2_EMIT=on (default off), and only once the owner's active wallet is known (absent when hidden / not bound / cursor not configured). available = the owner's launch2 rows of chainId are merged (indexerBlockNumber = the launch2_event lane checkpoint, headBlockNumber = the Launch chain head or null); unavailable = none are (${reasons}); the primary-chain rows stand.`,
    anyOf: [
      {
        type: "object",
        additionalProperties: false,
        required: [
          "status",
          "chainId",
          "indexerBlockNumber",
          "headBlockNumber",
        ],
        properties: {
          status: { type: "string", const: "available" },
          chainId: { type: "string", pattern: chainIdPatternSource },
          indexerBlockNumber: blockNumberSchema,
          headBlockNumber: { anyOf: [blockNumberSchema, { type: "null" }] },
        },
      },
      unavailableSchema,
    ],
  } as const;
}

const holdingItemSchema = {
  type: "object",
  additionalProperties: false,
  required: ["assetId", "symbol", "name", "logoUrl", "balance", "usdValue"],
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
} as const;

/**
 * Decision 0169: one Launch-chain (MEME v2) holding of the owner. Sent only
 * with PROFILE_LAUNCH2_EMIT=on; a client tells it from a primary-chain row
 * by the `kind` key. Two shapes with the same ten keys: a MEME row always
 * has `amountMeme` (and `nftCount` null), an NFT row always has `nftCount`
 * (and `amountMeme` / `valueUsd1` null).
 */
function launch2HoldingItemSchema(kind: "meme" | "nft") {
  const meme = kind === "meme";
  return {
    type: "object",
    additionalProperties: false,
    required: [
      "kind",
      "chainId",
      "instanceId",
      "ticker",
      "name",
      "logoUrl",
      "amountMeme",
      "nftCount",
      "stage",
      "valueUsd1",
    ],
    properties: {
      kind: {
        type: "string",
        const: meme
          ? profileLaunch2HoldingKinds[0]
          : profileLaunch2HoldingKinds[1],
        description: meme
          ? "MEME of the instance held: the live balance once graduated (an unreadable balance emits no row, never a guessed zero), else curve bought − sold."
          : "The instance's NFTs held (indexed NFT transfers).",
      },
      chainId: {
        type: "string",
        pattern: chainIdPatternSource,
        description: "CAIP-2 of the Launch chain (eip155:97, or eip155:56).",
      },
      instanceId: { type: "string", pattern: opaqueIdPatternSource },
      ticker: { type: "string", minLength: 1, maxLength: 80 },
      name: { type: "string", minLength: 1, maxLength: 64 },
      logoUrl: {
        anyOf: [{ type: "string", maxLength: 2048 }, { type: "null" }],
      },
      amountMeme: meme
        ? {
            ...launch2DecimalSchema,
            description:
              "MEME held, > 0 (18 decimals, human decimal string as /v2/launch2/*).",
          }
        : { type: "null" },
      nftCount: meme ? { type: "null" } : { type: "integer", minimum: 1 },
      stage: { type: "string", enum: [...launch2Stages] },
      valueUsd1: meme
        ? {
            anyOf: [launch2DecimalSchema, { type: "null" }],
            description:
              "amountMeme × the indexed last price (pool once graduated, else curve) in USD1; null without a price. Not added to totalUsd.",
          }
        : { type: "null" },
    },
  } as const;
}

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
        anyOf: [
          holdingItemSchema,
          launch2HoldingItemSchema("meme"),
          launch2HoldingItemSchema("nft"),
        ],
        description:
          "Primary-chain rows only by default. Decision 0169: with PROFILE_LAUNCH2_EMIT=on (default off; build >= 34 clients) the owner's Launch-chain rows (they carry `kind`) follow them; status / reasonCode / totalUsd / observedAt keep describing the primary chain only.",
      },
    },
    observedAt: nullableDateTime,
    launch2: launch2BlockSchema(
      "LAUNCH2_INDEXER_NOT_STARTED, LAUNCH2_HOLDINGS_READ_FAILED, LAUNCH2_REPOSITORY_UNAVAILABLE",
    ),
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
        anyOf: [
          {
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
          walletActivityLaunch2ItemSchema,
        ],
        description:
          "Primary-chain rows only by default. Decision 0169: with PROFILE_LAUNCH2_EMIT=on (default off; build >= 34 clients) the owner's Launch-chain launch2 rows (the Decision 0167 row: they carry `chainId` / `instanceId` / `occurredAt`; their `kind` values start with `launch2_`) are mixed in, newest first by (time, blockNumber, logIndex); a primary row's time is its blockTimestamp, else its indexer observation time. The cursor of the merged list is not interchangeable with the unmerged one (400 INVALID_REQUEST either way).",
      },
    },
    nextCursor: {
      anyOf: [
        { type: "string", minLength: 1, maxLength: 1536 },
        { type: "null" },
      ],
    },
    launch2: launch2BlockSchema(
      "LAUNCH2_INDEXER_NOT_STARTED, LAUNCH2_ACTIVITY_READ_FAILED, LAUNCH2_REPOSITORY_UNAVAILABLE",
    ),
    contractVersion: { type: "string", const: v2ContractVersion },
  },
} as const;

/** Decision 0169: the communities the profile owner joined. */
const communitiesResourceSchema = {
  anyOf: [
    {
      type: "object",
      additionalProperties: false,
      required: ["status", "items", "nextCursor", "contractVersion"],
      properties: {
        status: { type: "string", const: "available" },
        items: {
          type: "array",
          maxItems: profileCommunityLimits.maximum,
          items: {
            type: "object",
            additionalProperties: false,
            required: [
              "communityId",
              "name",
              "slug",
              "logoRef",
              "memberCount",
              "verificationStatus",
              "joinedAt",
            ],
            properties: {
              communityId: { type: "string", pattern: opaqueIdPatternSource },
              name: { type: "string", minLength: 1, maxLength: 40 },
              slug: { type: "string", pattern: "^[a-z0-9-]{3,32}$" },
              logoRef: {
                anyOf: [
                  {
                    type: "string",
                    pattern:
                      "^(avatar:preset/community-(0[1-9]|1[0-2])|logo:media/[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})$",
                  },
                  { type: "null" },
                ],
                description:
                  "`avatar:preset/community-NN` or `logo:media/{mediaId}` (rendered as for the community resources); anything else is null.",
              },
              memberCount: { type: "integer", minimum: 0 },
              verificationStatus: {
                type: "string",
                enum: ["verified", "unverified"],
                description:
                  "Only verified communities are listed today (the set counts.communities counts); `unverified` is reserved.",
              },
              joinedAt: { type: "string", format: "date-time" },
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
    },
    {
      type: "object",
      additionalProperties: false,
      required: ["status", "reasonCode", "contractVersion"],
      properties: {
        status: { type: "string", const: "unavailable" },
        reasonCode: {
          type: "string",
          const: profileCommunitiesHiddenReasonCode,
        },
        contractVersion: { type: "string", const: v2ContractVersion },
      },
    },
  ],
} as const;

const communitiesQuerySchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    cursor: { type: "string", minLength: 1, maxLength: 1536 },
    limit: {
      type: "integer",
      minimum: 1,
      maximum: profileCommunityLimits.maximum,
      description:
        "Page size, 1-50. Absent: 20 on the first page; with a cursor, the size of the page that issued it.",
    },
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
          "The owner's selected active wallet read on chain through the wallet balance service (one block, registry assets, zero rows omitted). `hidden` when the owner's privacy `visibility.totalAssets` is `self` (the owner always sees their own). `unavailable` with a reasonCode when no wallet is bound or the chain cannot be read; never a zero. No address is published. Decision 0169: with PROFILE_LAUNCH2_EMIT=on (default off) the owner's MEME v2 holdings on the Launch chain (launch2_meme / launch2_nft rows, see items) follow the primary rows and the optional `launch2` block reports that leg; status / totalUsd stay primary-chain only, so items may hold launch2 rows while status is `unavailable`.",
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
          "Indexed swaps and registry-asset transfers of the owner's selected active wallet, newest first (Decision 0095 §3 kind rules: a swap whose recipient or sender is the wallet is buy/sell of the non-quote token; other transfers are transfer_in/transfer_out). `hidden` when `visibility.tradeHistory` is `self`. Opaque cursor bound to the viewer and the profile. Decision 0169: with PROFILE_LAUNCH2_EMIT=on (default off) the owner's MEME v2 activity on the Launch chain (the Decision 0167 launch2 rows) is mixed in under a merged cursor, with the optional `launch2` block; status / reasonCode stay primary-chain only, so items may hold launch2 rows while status is `unavailable` (BSC_INDEXER_NOT_STARTED).",
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

  app.get(
    "/v2/profiles/:publicProfileId/communities",
    {
      schema: {
        operationId: "listV2PublicProfileCommunities",
        summary: "List the communities a public profile joined",
        description:
          "Decision 0169. Page: first request `limit` (default 20), later requests only `cursor` (keeps the first page's size). The owner's current memberships (active or muted; banned excluded; owner role included) of verified communities — the set `counts.communities` counts; a rejected (taken-down) or pending community is not listed — newest join first (joinedAt, then communityId). `unavailable` with reasonCode PROFILE_COMMUNITIES_HIDDEN when the owner's privacy `visibility.communities` is not `everyone` (default `everyone` since Decision 0169; the owner always sees their own). Not found / not activated / blocked-by-the-target is 404 PROFILE_NOT_FOUND as for the profile. limit 1-50 (default 20); opaque cursor bound to the viewer and the profile (a bad or foreign cursor is 400 INVALID_REQUEST).",
        tags: ["social"],
        security: [{ privyBearer: [] }],
        headers: v2CommonHeadersSchema,
        params: publicProfileIdParamsSchema,
        querystring: communitiesQuerySchema,
        response: { 200: communitiesResourceSchema, ...profileReadErrors },
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
      const resource = await service.getCommunities({
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
