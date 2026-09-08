import type { FastifyRequest, onRequestHookHandler } from "fastify";

import { noStoreResponseHeaders } from "../../core/http/schemas.js";
import { V2ApiError, v2ErrorResponseSchema } from "../../core/http/v2-error.js";
import {
  blockKinds,
  communityListLimits,
  communityLogoRefPatternSource,
  communityMembershipFilters,
  communitySlugPatternSource,
  communitySortValues,
  communityVerificationFilters,
  communityVerificationStatuses,
  canonicalBoundAssetKeyPatternSource,
  boundAssetKeyPatternSource,
  connectionDirections,
  hasIdempotencyKeyHeader,
  maximumCommunityDescriptionCodePoints,
  maximumCommunityNameCodePoints,
  maximumRawTextLength,
  memberRoleFilters,
  messageRequestDecisions,
  opaqueIdPatternSource,
  parseV2CommandMetadata,
  publicProfileIdPatternSource,
  safeTextPatternSource,
  searchDomains,
  searchResultLimits,
  storedAvatarRefPatternSource,
  v2CommandHeadersSchema,
} from "../../features/community/community-contract.js";
import {
  communityMembershipStatuses,
  communityRoles,
} from "../../features/community/community-policy.js";
import {
  communityChannelMemberStates,
  streamChannelCidPatternSource,
} from "../../features/communication/communication-contract.js";
import { loopIdPatternSource } from "../../features/identity/loop-id.js";
import { v2ContractVersion } from "../../features/meta/product-policy.js";
import {
  parseV2CommonRequestMetadata,
  v2CommonHeadersSchema,
} from "../../features/session/session-contract.js";

/**
 * Shared V2 community/social/search route schema fragments. Route schemas are
 * the OpenAPI source, so every bounded object rejects unknown properties and
 * the identity projection is defined exactly once.
 */

export const maximumCursorLength = 1_536;

export const cursorSchema = {
  type: "string",
  minLength: 3,
  maxLength: maximumCursorLength,
  pattern: "^[A-Za-z0-9_-]+\\.[A-Za-z0-9_-]+$",
  description:
    "Opaque cursor bound to the authenticated owner, route, and canonical filter. It carries the page size, so limit and cursor are mutually exclusive.",
} as const;

export const nullableCursorSchema = {
  anyOf: [cursorSchema, { type: "null" }],
} as const;

export const listLimitSchema = {
  type: "integer",
  minimum: 1,
  maximum: communityListLimits.maximum,
} as const;

export const searchLimitSchema = {
  type: "integer",
  minimum: 1,
  maximum: searchResultLimits.maximum,
} as const;

export const unavailableSchema = {
  type: "object",
  additionalProperties: false,
  required: ["status", "reasonCode"],
  properties: {
    status: { type: "string", const: "unavailable" },
    reasonCode: {
      type: "string",
      pattern: "^[A-Z][A-Z0-9_]{0,63}$",
      description:
        "Machine reason a fact is not published. It never becomes zero, an empty success, or a fixture.",
    },
  },
} as const;

export const identityProjectionSchema = {
  type: "object",
  additionalProperties: false,
  required: ["publicProfileId", "loopId", "alias", "avatarRef"],
  properties: {
    publicProfileId: {
      type: "string",
      pattern: publicProfileIdPatternSource,
      description:
        "Opaque public identity of another account; the only accepted command target.",
    },
    loopId: { type: "string", pattern: loopIdPatternSource },
    alias: {
      anyOf: [
        { type: "string", minLength: 1, maxLength: maximumRawTextLength },
        { type: "null" },
      ],
    },
    avatarRef: {
      anyOf: [
        { type: "string", pattern: storedAvatarRefPatternSource },
        { type: "null" },
      ],
    },
  },
} as const;

/**
 * Member-directory identity. `publicProfileId` is null only for a membership
 * whose profile row is missing: the row is still listed and counted so the
 * page matches the server counts, but it can never be a governance target.
 */
export const memberIdentitySchema = {
  type: "object",
  additionalProperties: false,
  required: ["publicProfileId", "loopId", "alias", "avatarRef"],
  properties: {
    publicProfileId: {
      anyOf: [
        { type: "string", pattern: publicProfileIdPatternSource },
        { type: "null" },
      ],
    },
    loopId: { type: "string", pattern: loopIdPatternSource },
    alias: {
      anyOf: [
        { type: "string", minLength: 1, maxLength: maximumRawTextLength },
        { type: "null" },
      ],
    },
    avatarRef: {
      anyOf: [
        { type: "string", pattern: storedAvatarRefPatternSource },
        { type: "null" },
      ],
    },
  },
} as const;

export const communitySummarySchema = {
  type: "object",
  additionalProperties: false,
  required: [
    "communityId",
    "name",
    "slug",
    "description",
    "logoRef",
    "verificationStatus",
    "boundAssetKey",
    "memberCount",
    "createdAt",
    "configVersion",
  ],
  properties: {
    communityId: { type: "string", pattern: opaqueIdPatternSource },
    name: { type: "string", minLength: 1, maxLength: maximumRawTextLength },
    slug: { type: "string", pattern: communitySlugPatternSource },
    description: {
      anyOf: [
        { type: "string", minLength: 1, maxLength: maximumRawTextLength },
        { type: "null" },
      ],
    },
    logoRef: {
      anyOf: [
        { type: "string", pattern: communityLogoRefPatternSource },
        { type: "null" },
      ],
    },
    verificationStatus: {
      type: "string",
      enum: [...communityVerificationStatuses],
    },
    boundAssetKey: {
      anyOf: [
        {
          type: "string",
          pattern: canonicalBoundAssetKeyPatternSource,
          description:
            "Canonical eip155:<chainId>:<lowercase address>. It is stored but not resolved before D10; no price, supply, or holder fact is implied.",
        },
        { type: "null" },
      ],
    },
    memberCount: {
      type: "integer",
      minimum: 0,
      description:
        "Server-maintained member count from PostgreSQL, excluding banned rows.",
    },
    createdAt: { type: "string", format: "date-time" },
    configVersion: { type: "string", const: "communityV1" },
  },
} as const;

export const membershipSchema = {
  type: "object",
  additionalProperties: false,
  required: ["role", "status", "joinedAt"],
  properties: {
    role: { type: "string", enum: [...communityRoles] },
    status: { type: "string", enum: [...communityMembershipStatuses] },
    joinedAt: { type: "string", format: "date-time" },
  },
} as const;

export const viewerSchema = {
  type: "object",
  additionalProperties: false,
  required: ["membership", "canInviteAdmin", "canMute", "canBan"],
  properties: {
    membership: { anyOf: [membershipSchema, { type: "null" }] },
    canInviteAdmin: { type: "boolean" },
    canMute: { type: "boolean" },
    canBan: { type: "boolean" },
  },
} as const;

export const recommendationSchema = {
  type: "object",
  additionalProperties: false,
  required: ["recommendationId", "ruleVersion"],
  properties: {
    recommendationId: { type: "string", format: "uuid" },
    ruleVersion: { type: "string", const: "rule:verified-members-v1" },
  },
} as const;

/**
 * Official community channel projection (Decision 0032). `available` proves a
 * provisioned Stream channel *and* a synced viewer membership; every other
 * state carries a machine reason code so the client can say "syncing" instead
 * of showing a CID it cannot open.
 */
const communityChatSchema = {
  type: "object",
  additionalProperties: false,
  required: ["status", "channelCid", "memberState", "reasonCode"],
  properties: {
    status: { type: "string", enum: ["available", "unavailable"] },
    channelCid: {
      anyOf: [
        { type: "string", pattern: streamChannelCidPatternSource },
        { type: "null" },
      ],
    },
    memberState: {
      anyOf: [
        { type: "string", enum: [...communityChannelMemberStates] },
        { type: "null" },
      ],
    },
    reasonCode: {
      anyOf: [
        { type: "string", pattern: "^[A-Z][A-Z0-9_]{0,63}$" },
        { type: "null" },
      ],
    },
  },
} as const;

const communityVoiceSchema = {
  type: "object",
  additionalProperties: false,
  required: ["status", "currentRoomId", "reasonCode"],
  properties: {
    status: { type: "string", enum: ["available", "unavailable"] },
    currentRoomId: {
      anyOf: [
        { type: "string", pattern: opaqueIdPatternSource },
        { type: "null" },
      ],
    },
    reasonCode: {
      anyOf: [
        { type: "string", pattern: "^[A-Z][A-Z0-9_]{0,63}$" },
        { type: "null" },
      ],
    },
  },
} as const;

export const communityResourceSchema = {
  type: "object",
  headers: noStoreResponseHeaders(),
  additionalProperties: false,
  required: [
    "community",
    "viewer",
    "chat",
    "voice",
    "miningPower",
    "onlineCount",
    "announcements",
    "officialLinks",
    "contractVersion",
  ],
  properties: {
    community: communitySummarySchema,
    viewer: viewerSchema,
    chat: communityChatSchema,
    voice: communityVoiceSchema,
    miningPower: unavailableSchema,
    onlineCount: unavailableSchema,
    announcements: unavailableSchema,
    officialLinks: unavailableSchema,
    contractVersion: { type: "string", const: v2ContractVersion },
  },
} as const;

export const communityListResourceSchema = {
  type: "object",
  headers: noStoreResponseHeaders(),
  additionalProperties: false,
  required: ["items", "nextCursor", "recommendation", "contractVersion"],
  properties: {
    items: {
      type: "array",
      maxItems: communityListLimits.maximum,
      items: communitySummarySchema,
    },
    nextCursor: nullableCursorSchema,
    recommendation: recommendationSchema,
    contractVersion: { type: "string", const: v2ContractVersion },
  },
} as const;

export const communityHomeResourceSchema = {
  type: "object",
  headers: noStoreResponseHeaders(),
  additionalProperties: false,
  required: [
    "joined",
    "discover",
    "unread",
    "liveVoice",
    "freshness",
    "recommendation",
    "contractVersion",
  ],
  properties: {
    joined: {
      type: "object",
      additionalProperties: false,
      required: ["items", "truncated"],
      properties: {
        items: {
          type: "array",
          maxItems: 50,
          items: {
            type: "object",
            additionalProperties: false,
            required: ["community", "membership"],
            properties: {
              community: communitySummarySchema,
              membership: membershipSchema,
            },
          },
        },
        truncated: {
          type: "boolean",
          description:
            "True when the account joined more communities than this aggregate carries; continue with GET /v2/communities?membership=joined.",
        },
      },
    },
    discover: {
      type: "array",
      maxItems: 5,
      items: communitySummarySchema,
    },
    unread: unavailableSchema,
    liveVoice: unavailableSchema,
    freshness: {
      type: "object",
      additionalProperties: false,
      required: ["observedAt", "source"],
      properties: {
        observedAt: { type: "string", format: "date-time" },
        source: { type: "string", const: "database" },
      },
    },
    recommendation: recommendationSchema,
    contractVersion: { type: "string", const: v2ContractVersion },
  },
} as const;

export const memberListResourceSchema = {
  type: "object",
  headers: noStoreResponseHeaders(),
  additionalProperties: false,
  required: [
    "community",
    "viewer",
    "counts",
    "items",
    "nextCursor",
    "contractVersion",
  ],
  properties: {
    community: communitySummarySchema,
    viewer: viewerSchema,
    counts: {
      type: "object",
      additionalProperties: false,
      required: ["all", "owner", "admin", "online"],
      properties: {
        all: { type: "integer", minimum: 0 },
        owner: { type: "integer", minimum: 0 },
        admin: { type: "integer", minimum: 0 },
        online: unavailableSchema,
      },
    },
    items: {
      type: "array",
      maxItems: communityListLimits.maximum,
      items: {
        type: "object",
        additionalProperties: false,
        required: [
          "profile",
          "role",
          "status",
          "joinedAt",
          "isSelf",
          "miningPower",
        ],
        properties: {
          profile: memberIdentitySchema,
          role: { type: "string", enum: [...communityRoles] },
          status: { type: "string", enum: [...communityMembershipStatuses] },
          joinedAt: { type: "string", format: "date-time" },
          isSelf: { type: "boolean" },
          miningPower: unavailableSchema,
        },
      },
    },
    nextCursor: nullableCursorSchema,
    contractVersion: { type: "string", const: v2ContractVersion },
  },
} as const;

export const connectionListResourceSchema = {
  type: "object",
  headers: noStoreResponseHeaders(),
  additionalProperties: false,
  required: ["direction", "items", "counts", "nextCursor", "contractVersion"],
  properties: {
    direction: { type: "string", enum: [...connectionDirections] },
    items: {
      type: "array",
      maxItems: communityListLimits.maximum,
      items: {
        type: "object",
        additionalProperties: false,
        required: ["profile", "createdAt", "viewerFollows", "miningPower"],
        properties: {
          profile: identityProjectionSchema,
          createdAt: { type: "string", format: "date-time" },
          viewerFollows: { type: "boolean" },
          miningPower: unavailableSchema,
        },
      },
    },
    counts: {
      type: "object",
      additionalProperties: false,
      required: ["following", "followers"],
      properties: {
        following: { type: "integer", minimum: 0 },
        followers: { type: "integer", minimum: 0 },
      },
    },
    nextCursor: nullableCursorSchema,
    contractVersion: { type: "string", const: v2ContractVersion },
  },
} as const;

export const followResourceSchema = {
  type: "object",
  headers: noStoreResponseHeaders(),
  additionalProperties: false,
  required: ["profile", "viewerFollows", "contractVersion"],
  properties: {
    profile: identityProjectionSchema,
    viewerFollows: { type: "boolean" },
    contractVersion: { type: "string", const: v2ContractVersion },
  },
} as const;

const blockProjectionSchema = {
  type: "object",
  additionalProperties: false,
  required: ["kind", "stableId", "profile", "reasonCode", "createdAt"],
  properties: {
    kind: { type: "string", enum: [...blockKinds] },
    stableId: { type: "string", minLength: 1, maxLength: 256 },
    profile: { anyOf: [identityProjectionSchema, { type: "null" }] },
    reasonCode: { type: "string", pattern: "^[a-z][a-z0-9_]{0,63}$" },
    createdAt: { type: "string", format: "date-time" },
  },
} as const;

export const blockListResourceSchema = {
  type: "object",
  headers: noStoreResponseHeaders(),
  additionalProperties: false,
  required: ["kind", "items", "counts", "nextCursor", "contractVersion"],
  properties: {
    kind: { type: "string", enum: [...blockKinds] },
    items: {
      type: "array",
      maxItems: communityListLimits.maximum,
      items: blockProjectionSchema,
    },
    counts: {
      type: "object",
      additionalProperties: false,
      required: ["user"],
      properties: { user: { type: "integer", minimum: 0 } },
    },
    nextCursor: nullableCursorSchema,
    contractVersion: { type: "string", const: v2ContractVersion },
  },
} as const;

export const blockResourceSchema = {
  type: "object",
  headers: noStoreResponseHeaders(),
  additionalProperties: false,
  required: ["block", "contractVersion"],
  properties: {
    block: { anyOf: [blockProjectionSchema, { type: "null" }] },
    contractVersion: { type: "string", const: v2ContractVersion },
  },
} as const;

export const messageRequestListResourceSchema = {
  type: "object",
  headers: noStoreResponseHeaders(),
  additionalProperties: false,
  required: ["items", "nextCursor", "contractVersion"],
  properties: {
    items: {
      type: "array",
      maxItems: communityListLimits.maximum,
      items: {
        type: "object",
        additionalProperties: false,
        required: [
          "messageRequestId",
          "profile",
          "createdAt",
          "expiresAt",
          "preview",
          "aiModeration",
        ],
        properties: {
          messageRequestId: { type: "string", pattern: opaqueIdPatternSource },
          profile: identityProjectionSchema,
          createdAt: { type: "string", format: "date-time" },
          expiresAt: { type: "string", format: "date-time" },
          preview: unavailableSchema,
          aiModeration: unavailableSchema,
        },
      },
    },
    nextCursor: nullableCursorSchema,
    contractVersion: { type: "string", const: v2ContractVersion },
  },
} as const;

export const messageRequestDecisionResourceSchema = {
  type: "object",
  headers: noStoreResponseHeaders(),
  additionalProperties: false,
  required: ["messageRequestId", "decision", "blocked", "contractVersion"],
  properties: {
    messageRequestId: { type: "string", pattern: opaqueIdPatternSource },
    decision: { type: "string", enum: [...messageRequestDecisions] },
    blocked: {
      type: "boolean",
      description:
        "True only for `report`, which rejects the request, blocks the sender, and writes the audit row in the same transaction.",
    },
    contractVersion: { type: "string", const: v2ContractVersion },
  },
} as const;

export const searchResourceSchema = {
  type: "object",
  headers: noStoreResponseHeaders(),
  additionalProperties: false,
  required: [
    "domain",
    "status",
    "reasonCode",
    "results",
    "nextCursor",
    "contractVersion",
  ],
  properties: {
    domain: { type: "string", enum: [...searchDomains] },
    status: { type: "string", enum: ["available", "unavailable"] },
    reasonCode: {
      anyOf: [
        { type: "string", pattern: "^[A-Z][A-Z0-9_]{0,63}$" },
        { type: "null" },
      ],
    },
    results: {
      type: "array",
      maxItems: searchResultLimits.maximum,
      items: {
        type: "object",
        additionalProperties: false,
        required: ["resultType", "stableId", "displaySnapshot", "destination"],
        properties: {
          resultType: { type: "string", enum: ["user", "community"] },
          stableId: { type: "string", pattern: opaqueIdPatternSource },
          displaySnapshot: {
            type: "object",
            additionalProperties: false,
            required: [
              "title",
              "subtitle",
              "avatarRef",
              "memberCount",
              "verificationStatus",
            ],
            properties: {
              title: {
                type: "string",
                minLength: 1,
                maxLength: maximumRawTextLength,
              },
              subtitle: {
                anyOf: [
                  {
                    type: "string",
                    minLength: 1,
                    maxLength: maximumRawTextLength,
                  },
                  { type: "null" },
                ],
              },
              avatarRef: {
                anyOf: [{ type: "string", maxLength: 256 }, { type: "null" }],
              },
              memberCount: {
                anyOf: [{ type: "integer", minimum: 0 }, { type: "null" }],
              },
              verificationStatus: {
                anyOf: [
                  { type: "string", enum: [...communityVerificationStatuses] },
                  { type: "null" },
                ],
              },
            },
          },
          destination: {
            type: "object",
            additionalProperties: false,
            required: ["kind"],
            properties: {
              kind: {
                type: "string",
                enum: ["publicProfile", "communityProfile"],
                description:
                  "Canonical destination kind. Clients map it to their own route and never build a route from display text.",
              },
            },
          },
        },
      },
    },
    nextCursor: nullableCursorSchema,
    contractVersion: { type: "string", const: v2ContractVersion },
  },
} as const;

export const createCommunityRequestSchema = {
  type: "object",
  additionalProperties: false,
  required: ["name", "slug", "description", "logoRef", "boundAssetKey"],
  properties: {
    name: {
      type: "string",
      minLength: 1,
      maxLength: maximumRawTextLength,
      pattern: safeTextPatternSource,
      description: `Trimmed to 1-${maximumCommunityNameCodePoints} Unicode code points with the alias character-safety rules; reserved and operator-blocked terms are rejected.`,
    },
    slug: { type: "string", pattern: communitySlugPatternSource },
    description: {
      anyOf: [
        {
          type: "string",
          minLength: 1,
          maxLength: maximumRawTextLength,
          pattern: safeTextPatternSource,
          description: `Trimmed to 1-${maximumCommunityDescriptionCodePoints} Unicode code points.`,
        },
        { type: "null" },
      ],
    },
    logoRef: {
      anyOf: [
        { type: "string", pattern: communityLogoRefPatternSource },
        { type: "null" },
      ],
    },
    boundAssetKey: {
      anyOf: [
        { type: "string", pattern: boundAssetKeyPatternSource },
        { type: "null" },
      ],
    },
  },
} as const;

export const updateCommunityRequestSchema = {
  type: "object",
  additionalProperties: false,
  minProperties: 1,
  properties: {
    name: createCommunityRequestSchema.properties.name,
    description: createCommunityRequestSchema.properties.description,
    logoRef: createCommunityRequestSchema.properties.logoRef,
    boundAssetKey: createCommunityRequestSchema.properties.boundAssetKey,
  },
} as const;

export const roleChangeRequestSchema = {
  type: "object",
  additionalProperties: false,
  required: ["role"],
  properties: { role: { type: "string", enum: [...communityRoles] } },
} as const;

export const blockRequestSchema = {
  type: "object",
  additionalProperties: false,
  required: ["kind", "stableId"],
  properties: {
    kind: { type: "string", enum: [...blockKinds] },
    stableId: { type: "string", minLength: 1, maxLength: 256 },
  },
} as const;

export const messageRequestDecisionRequestSchema = {
  type: "object",
  additionalProperties: false,
  required: ["decision"],
  properties: {
    decision: { type: "string", enum: [...messageRequestDecisions] },
  },
} as const;

export const communityIdParamsSchema = {
  type: "object",
  additionalProperties: false,
  required: ["communityId"],
  properties: {
    communityId: { type: "string", pattern: opaqueIdPatternSource },
  },
} as const;

export const memberParamsSchema = {
  type: "object",
  additionalProperties: false,
  required: ["communityId", "publicProfileId"],
  properties: {
    communityId: { type: "string", pattern: opaqueIdPatternSource },
    publicProfileId: { type: "string", pattern: publicProfileIdPatternSource },
  },
} as const;

export const publicProfileIdParamsSchema = {
  type: "object",
  additionalProperties: false,
  required: ["publicProfileId"],
  properties: {
    publicProfileId: { type: "string", pattern: publicProfileIdPatternSource },
  },
} as const;

export const communityListQuerySchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    sort: { type: "string", enum: [...communitySortValues] },
    verification: { type: "string", enum: [...communityVerificationFilters] },
    membership: {
      type: "string",
      enum: [...communityMembershipFilters],
      description:
        "`joined` narrows the page to the caller's own memberships; it is the cursor-paged continuation of the home aggregate.",
    },
    cursor: cursorSchema,
    limit: listLimitSchema,
  },
} as const;

export const memberListQuerySchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    role: { type: "string", enum: [...memberRoleFilters] },
    cursor: cursorSchema,
    limit: listLimitSchema,
  },
} as const;

export const connectionListQuerySchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    direction: { type: "string", enum: [...connectionDirections] },
    cursor: cursorSchema,
    limit: listLimitSchema,
  },
} as const;

export const blockListQuerySchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    kind: { type: "string", enum: [...blockKinds] },
    cursor: cursorSchema,
    limit: listLimitSchema,
  },
} as const;

export const pageQuerySchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    cursor: cursorSchema,
    limit: listLimitSchema,
  },
} as const;

export const searchQuerySchema = {
  type: "object",
  additionalProperties: false,
  required: ["domain", "q"],
  properties: {
    domain: { type: "string", enum: [...searchDomains] },
    q: {
      type: "string",
      minLength: 1,
      maxLength: 256,
      pattern: safeTextPatternSource,
      description:
        "Literal prefix. After trimming, NFKC normalization, and ASCII-space folding it must contain 2-40 Unicode code points; chat content is never searched.",
    },
    verification: { type: "string", enum: [...communityVerificationFilters] },
    cursor: cursorSchema,
    limit: searchLimitSchema,
  },
} as const;

export const referralRulesResourceSchema = {
  type: "object",
  headers: noStoreResponseHeaders(),
  additionalProperties: false,
  required: [
    "configVersion",
    "effectiveAt",
    "appliesTo",
    "levels",
    "edges",
    "inviteCode",
    "contractVersion",
  ],
  properties: {
    configVersion: { type: "string", const: "referralRulesV1" },
    effectiveAt: { type: "string", format: "date-time" },
    appliesTo: {
      type: "string",
      const: "miningPower",
      description:
        "The referral rule is a Mining Power boost only. It is never revenue, commission, or a rebate.",
    },
    levels: {
      type: "array",
      minItems: 5,
      maxItems: 5,
      items: {
        type: "object",
        additionalProperties: false,
        required: ["level", "boostPercent", "descriptionKey"],
        properties: {
          level: { type: "integer", minimum: 1, maximum: 5 },
          boostPercent: {
            type: "string",
            pattern: "^[0-9]+(\\.[0-9]+)?$",
            description:
              "Canonical decimal string; ratios are never JavaScript numbers.",
          },
          descriptionKey: { type: "string", minLength: 1, maxLength: 64 },
        },
      },
    },
    edges: unavailableSchema,
    inviteCode: unavailableSchema,
    contractVersion: { type: "string", const: v2ContractVersion },
  },
} as const;

export const readErrors = {
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

export const commandErrors = {
  ...readErrors,
  403: v2ErrorResponseSchema(["PERMISSION_DENIED", "POLICY_BLOCKED"]),
  409: v2ErrorResponseSchema([
    "ACCOUNT_BOOTSTRAP_REQUIRED",
    "DATA_STALE",
    "IDEMPOTENCY_CONFLICT",
    "PROFILE_ACTIVATION_REQUIRED",
    "RESOURCE_CONFLICT",
    "VERSION_CONFLICT",
  ]),
  422: v2ErrorResponseSchema([
    "VALIDATION_FAILED",
    "ALIAS_RESERVED",
    "ALIAS_BLOCKED",
  ]),
} as const;

export const searchErrors = {
  ...readErrors,
  429: v2ErrorResponseSchema(["RATE_LIMITED"]),
} as const;

export function validateCommonHeaders(request: FastifyRequest): Promise<void> {
  parseV2CommonRequestMetadata(request.raw.rawHeaders);
  if (hasIdempotencyKeyHeader(request.raw.rawHeaders)) {
    throw V2ApiError.invalidRequest();
  }
  return Promise.resolve();
}

/** Every community and social-graph write requires exactly one UUIDv4 key. */
export const validateCommandHeaders: onRequestHookHandler = (
  request,
  _reply,
  done,
): void => {
  try {
    parseV2CommandMetadata(request.raw.rawHeaders);
    done();
  } catch (error) {
    done(error instanceof Error ? error : V2ApiError.invalidRequest());
  }
};

export function assertNoQuery(request: FastifyRequest): Promise<void> {
  const query = request.query as Record<string, unknown>;
  if (Object.keys(query).length > 0) {
    throw V2ApiError.invalidRequest();
  }
  return Promise.resolve();
}

export function assertNoBodyOrQueryV2(request: FastifyRequest): Promise<void> {
  const query = request.query as Record<string, unknown>;
  if (request.body !== undefined || Object.keys(query).length > 0) {
    throw V2ApiError.invalidRequest();
  }
  return Promise.resolve();
}

export function assertNoBodyV2(request: FastifyRequest): Promise<void> {
  if (request.body !== undefined) {
    throw V2ApiError.invalidRequest();
  }
  return Promise.resolve();
}

export { v2CommandHeadersSchema, v2CommonHeadersSchema };
