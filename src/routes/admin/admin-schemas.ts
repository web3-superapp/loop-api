import { noStoreResponseHeaders } from "../../core/http/schemas.js";
import {
  adminErrorResponseSchema,
  adminSessionCookieName,
  type AdminErrorCode,
} from "../../features/admin/admin-contract.js";
import {
  intelPromotionDeeplinkPatternSource,
  intelPromotionsConfigVersionPatternSource,
  intelPromotionImageUrlMaximumLength,
  intelPromotionsMaximumItems,
} from "../../features/market/intel-promotions.js";

/**
 * Route schemas of the operator console (Decision 0102); the source of
 * `openapi/loop-admin.v1.json`. Never part of the `/v2` artifact.
 */

const uuidSchema = { type: "string", format: "uuid" } as const;
const dateTimeSchema = { type: "string", format: "date-time" } as const;
const nullableDateTimeSchema = {
  anyOf: [dateTimeSchema, { type: "null" }],
} as const;
const nullableStringSchema = {
  anyOf: [{ type: "string" }, { type: "null" }],
} as const;
const decimalSchema = {
  type: "string",
  pattern: "^(0|[1-9][0-9]{0,77})(\\.[0-9]{1,60})?$",
} as const;
const nullableDecimalSchema = {
  anyOf: [decimalSchema, { type: "null" }],
} as const;
const reasonCodeSchema = {
  type: "string",
  pattern: "^[a-z][a-z0-9_]{0,63}$",
  description: "Machine reason code, lower snake case (Decision 0073).",
} as const;
const reasonTextSchema = {
  type: ["string", "null"],
  maxLength: 1024,
  description: "Trimmed, 1-280 code points, no control characters.",
} as const;
const cursorSchema = { type: "string", minLength: 1, maxLength: 1024 } as const;
const nullableCursorSchema = {
  anyOf: [cursorSchema, { type: "null" }],
} as const;
const limitSchema = {
  type: "integer",
  minimum: 1,
  maximum: 100,
  description: "Default 20. Not allowed together with `cursor`.",
} as const;
const configVersionSchema = {
  type: "string",
  pattern: "^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$",
} as const;
const anyJsonSchema = {
  description: "Any JSON value (audit snapshot).",
} as const;
const looseObjectSchema = {
  type: "object",
  additionalProperties: true,
} as const;

export function adminErrors(
  ...codes: readonly AdminErrorCode[]
): Record<number, ReturnType<typeof adminErrorResponseSchema>> {
  const byStatus = new Map<number, AdminErrorCode[]>();
  const statusOf: Record<AdminErrorCode, number> = {
    ADMIN_SESSION_REQUIRED: 401,
    ADMIN_LOGIN_INVALID: 401,
    ADMIN_LOGIN_LOCKED: 423,
    ADMIN_LOGIN_BUSY: 429,
    ADMIN_CONFLICT: 409,
    INVALID_REQUEST: 400,
    VALIDATION_FAILED: 422,
    NOT_FOUND: 404,
    CAPABILITY_UNAVAILABLE: 503,
    REQUEST_TIMEOUT: 503,
    INTERNAL_ERROR: 500,
  };
  for (const code of [...codes, "INTERNAL_ERROR" as const]) {
    const status = statusOf[code];
    byStatus.set(status, [...(byStatus.get(status) ?? []), code]);
  }
  const result: Record<
    number,
    ReturnType<typeof adminErrorResponseSchema>
  > = {};
  for (const [status, list] of byStatus) {
    result[status] = adminErrorResponseSchema([...new Set(list)].sort());
  }
  return result;
}

/** Errors every session-protected route can return. */
export const sessionErrors = [
  "ADMIN_SESSION_REQUIRED",
  "INVALID_REQUEST",
  "REQUEST_TIMEOUT",
] as const satisfies readonly AdminErrorCode[];

export const adminSecurity = [{ adminSession: [] }];

export const auditReferenceSchema = {
  type: "object",
  additionalProperties: false,
  required: ["auditId", "seq", "at"],
  properties: {
    auditId: uuidSchema,
    seq: {
      type: "integer",
      minimum: 1,
      description: "Display number of the audit row (「审计 #seq」).",
    },
    at: dateTimeSchema,
  },
} as const;

export const auditRecordSchema = {
  type: "object",
  additionalProperties: false,
  required: [
    "auditId",
    "seq",
    "at",
    "actor",
    "action",
    "targetType",
    "targetId",
    "before",
    "after",
    "requestId",
  ],
  properties: {
    auditId: uuidSchema,
    seq: { type: "integer", minimum: 1 },
    at: dateTimeSchema,
    actor: { type: "string" },
    action: { type: "string" },
    targetType: { type: "string" },
    targetId: nullableStringSchema,
    before: anyJsonSchema,
    after: anyJsonSchema,
    requestId: uuidSchema,
  },
} as const;

export const sessionRequestSchema = {
  type: "object",
  additionalProperties: false,
  required: ["username", "password"],
  properties: {
    username: { type: "string", minLength: 1, maxLength: 64 },
    password: { type: "string", minLength: 1, maxLength: 1024 },
  },
} as const;

export const sessionResourceSchema = {
  type: "object",
  headers: {
    ...noStoreResponseHeaders(),
    "set-cookie": {
      type: "string",
      description: `${adminSessionCookieName}=<signed>; Path=/admin; Max-Age=43200; HttpOnly; SameSite=Strict; Secure`,
    },
  },
  additionalProperties: false,
  required: ["actor", "issuedAt", "expiresAt"],
  properties: {
    actor: { type: "string" },
    issuedAt: dateTimeSchema,
    expiresAt: dateTimeSchema,
  },
} as const;

export const noContentSchema = {
  type: "null",
  headers: noStoreResponseHeaders(),
  description: "No content; the session cookie is cleared.",
} as const;

const communityRecordSchema = {
  type: "object",
  additionalProperties: false,
  required: [
    "communityId",
    "name",
    "slug",
    "description",
    "logoRef",
    "verificationStatus",
    "boundAssetId",
    "memberCount",
    "ownerUserId",
    "ownerLoopId",
    "applicationSubmittedAt",
    "reviewedAt",
    "verifiedAt",
    "rejectedReason",
    "createdAt",
    "updatedAt",
  ],
  properties: {
    communityId: uuidSchema,
    name: { type: "string" },
    slug: { type: "string" },
    description: nullableStringSchema,
    logoRef: nullableStringSchema,
    verificationStatus: {
      type: "string",
      enum: ["pending", "verified", "rejected"],
    },
    boundAssetId: nullableStringSchema,
    memberCount: { type: "integer", minimum: 0 },
    ownerUserId: uuidSchema,
    ownerLoopId: nullableStringSchema,
    applicationSubmittedAt: nullableDateTimeSchema,
    reviewedAt: nullableDateTimeSchema,
    verifiedAt: nullableDateTimeSchema,
    rejectedReason: nullableStringSchema,
    createdAt: dateTimeSchema,
    updatedAt: dateTimeSchema,
  },
} as const;

const reviewNoteSchema = {
  type: "object",
  additionalProperties: false,
  required: [
    "noteId",
    "communityId",
    "at",
    "actor",
    "decision",
    "reasonCode",
    "reasonText",
    "auditId",
  ],
  properties: {
    noteId: uuidSchema,
    communityId: uuidSchema,
    at: dateTimeSchema,
    actor: { type: "string" },
    decision: { type: "string", enum: ["verify", "reject"] },
    reasonCode: { type: "string" },
    reasonText: nullableStringSchema,
    auditId: uuidSchema,
  },
} as const;

export const overviewResourceSchema = {
  type: "object",
  headers: noStoreResponseHeaders(),
  additionalProperties: false,
  required: [
    "accounts",
    "communities",
    "pendingReviews",
    "voiceRooms",
    "memeTokens",
    "indexerLanes",
    "recentAudit",
    "observedAt",
  ],
  properties: {
    accounts: { type: "integer", minimum: 0 },
    communities: {
      type: "object",
      additionalProperties: false,
      required: ["pending", "verified", "rejected"],
      properties: {
        pending: { type: "integer", minimum: 0 },
        verified: { type: "integer", minimum: 0 },
        rejected: { type: "integer", minimum: 0 },
      },
    },
    pendingReviews: { type: "integer", minimum: 0 },
    voiceRooms: {
      type: "object",
      additionalProperties: false,
      required: ["live", "participants"],
      properties: {
        live: { type: "integer", minimum: 0 },
        participants: { type: "integer", minimum: 0 },
      },
    },
    memeTokens: {
      type: "object",
      additionalProperties: false,
      required: ["byStatus", "hidden"],
      properties: {
        byStatus: {
          type: "object",
          additionalProperties: { type: "integer", minimum: 0 },
        },
        hidden: { type: "integer", minimum: 0 },
      },
    },
    indexerLanes: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: [
          "lane",
          "chainId",
          "lastBlockNumber",
          "updatedAt",
          "secondsSinceUpdate",
        ],
        properties: {
          lane: { type: "string" },
          chainId: { type: "string" },
          lastBlockNumber: { type: "string", pattern: "^[0-9]+$" },
          updatedAt: dateTimeSchema,
          secondsSinceUpdate: { type: "integer", minimum: 0 },
        },
      },
    },
    recentAudit: { type: "array", maxItems: 20, items: auditRecordSchema },
    observedAt: dateTimeSchema,
  },
} as const;

const recommendedCommunityProperties = {
  communityIds: { type: "array", maxItems: 50, items: uuidSchema },
  source: { type: "string", enum: ["database", "environment"] },
  updatedAt: nullableDateTimeSchema,
  updatedBy: nullableStringSchema,
  environmentCommunityIds: { type: "array", maxItems: 50, items: uuidSchema },
  defaultSelectedCount: { type: "integer", const: 5 },
  communities: {
    type: "array",
    items: {
      type: "object",
      additionalProperties: false,
      required: [
        "communityId",
        "name",
        "slug",
        "logoRef",
        "verificationStatus",
        "memberCount",
      ],
      properties: {
        communityId: uuidSchema,
        name: { type: "string" },
        slug: { type: "string" },
        logoRef: nullableStringSchema,
        verificationStatus: {
          type: "string",
          enum: ["pending", "verified", "rejected"],
        },
        memberCount: { type: "integer", minimum: 0 },
      },
    },
  },
} as const;
const recommendedCommunityRequired = [
  "communityIds",
  "source",
  "updatedAt",
  "updatedBy",
  "environmentCommunityIds",
  "defaultSelectedCount",
  "communities",
] as const;

export const recommendedCommunitiesResourceSchema = {
  type: "object",
  headers: noStoreResponseHeaders(),
  additionalProperties: false,
  required: [...recommendedCommunityRequired],
  properties: recommendedCommunityProperties,
} as const;

export const recommendedCommunitiesWriteResourceSchema = {
  type: "object",
  headers: noStoreResponseHeaders(),
  additionalProperties: false,
  required: [...recommendedCommunityRequired, "audit"],
  properties: {
    ...recommendedCommunityProperties,
    audit: auditReferenceSchema,
  },
} as const;

export const recommendedCommunitiesRequestSchema = {
  type: "object",
  additionalProperties: false,
  required: ["communityIds", "updatedAt"],
  properties: {
    communityIds: {
      type: ["array", "null"],
      maxItems: 50,
      items: { type: "string" },
      description:
        "Ordered verified community IDs (the first five are pre-selected). `null` deletes the console list so RECOMMENDED_COMMUNITY_IDS is in force again.",
    },
    updatedAt: {
      type: ["string", "null"],
      maxLength: 64,
      description:
        "The `updatedAt` last read; `null` when no console list exists yet. A mismatch is 409 ADMIN_CONFLICT.",
    },
  },
} as const;

const promotionItemSchema = {
  type: "object",
  additionalProperties: false,
  required: [
    "id",
    "title",
    "subtitle",
    "imageUrl",
    "deeplink",
    "startsAt",
    "endsAt",
    "order",
  ],
  properties: {
    id: uuidSchema,
    title: { type: "string", minLength: 1, maxLength: 40 },
    subtitle: { type: "string", maxLength: 80 },
    imageUrl: {
      anyOf: [
        {
          type: "string",
          pattern: "^https://",
          maxLength: intelPromotionImageUrlMaximumLength,
        },
        { type: "null" },
      ],
    },
    deeplink: { type: "string", pattern: intelPromotionDeeplinkPatternSource },
    startsAt: dateTimeSchema,
    endsAt: dateTimeSchema,
    order: { type: "integer", minimum: 0 },
  },
} as const;

const promotionsProperties = {
  items: {
    type: "array",
    maxItems: intelPromotionsMaximumItems,
    items: promotionItemSchema,
  },
  source: { type: "string", enum: ["database", "constant"] },
  updatedAt: nullableDateTimeSchema,
  updatedBy: nullableStringSchema,
  configVersion: {
    type: "string",
    pattern: intelPromotionsConfigVersionPatternSource,
  },
  effectiveAt: dateTimeSchema,
  deeplinkPattern: { type: "string" },
  deeplinkChoices: { type: "array", items: { type: "string" } },
  maximumItems: { type: "integer", const: intelPromotionsMaximumItems },
  imageHosts: {
    type: "array",
    items: { type: "string" },
    description:
      "INTEL_PROMOTION_IMAGE_HOSTS (Decision 0105): hosts an https `imageUrl` may use. Empty = `imageUrl` must be null.",
  },
  imageUrlMaximumLength: {
    type: "integer",
    const: intelPromotionImageUrlMaximumLength,
  },
} as const;
const promotionsRequired = [
  "items",
  "source",
  "updatedAt",
  "updatedBy",
  "configVersion",
  "effectiveAt",
  "deeplinkPattern",
  "deeplinkChoices",
  "maximumItems",
  "imageHosts",
  "imageUrlMaximumLength",
] as const;

export const intelPromotionsAdminResourceSchema = {
  type: "object",
  headers: noStoreResponseHeaders(),
  additionalProperties: false,
  required: [...promotionsRequired],
  properties: promotionsProperties,
} as const;

export const intelPromotionsAdminWriteResourceSchema = {
  type: "object",
  headers: noStoreResponseHeaders(),
  additionalProperties: false,
  required: [...promotionsRequired, "audit"],
  properties: { ...promotionsProperties, audit: auditReferenceSchema },
} as const;

export const intelPromotionsRequestSchema = {
  type: "object",
  additionalProperties: false,
  required: ["items", "updatedAt"],
  properties: {
    items: {
      type: ["array", "null"],
      maxItems: intelPromotionsMaximumItems,
      items: {
        type: "object",
        additionalProperties: false,
        required: [
          "title",
          "subtitle",
          "imageUrl",
          "deeplink",
          "startsAt",
          "endsAt",
          "order",
        ],
        properties: {
          id: {
            type: "string",
            maxLength: 64,
            description: "Omit for a new card; the server assigns a UUIDv4.",
          },
          title: { type: "string", maxLength: 200 },
          subtitle: { type: "string", maxLength: 400 },
          imageUrl: {
            type: ["string", "null"],
            maxLength: 2048,
            description:
              "null, or an https URL of at most 512 characters on an INTEL_PROMOTION_IMAGE_HOSTS host (else 422 ADMIN_PROMOTION_INVALID, `field: imageUrl`). Title and subtitle refuse control and format characters.",
          },
          deeplink: { type: "string", maxLength: 256 },
          startsAt: { type: "string", maxLength: 64 },
          endsAt: { type: "string", maxLength: 64 },
          order: { type: "integer" },
        },
      },
      description:
        "Whole-list replacement. `null` deletes the console list so the shipped list is in force again.",
    },
    updatedAt: {
      type: ["string", "null"],
      maxLength: 64,
    },
  },
} as const;

export const communitiesQuerySchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    status: { type: "string", enum: ["pending", "verified", "rejected"] },
    q: { type: "string", maxLength: 64 },
    cursor: cursorSchema,
    limit: limitSchema,
  },
} as const;

export const communityListResourceSchema = {
  type: "object",
  headers: noStoreResponseHeaders(),
  additionalProperties: false,
  required: ["items", "nextCursor"],
  properties: {
    items: { type: "array", maxItems: 100, items: communityRecordSchema },
    nextCursor: nullableCursorSchema,
  },
} as const;

export const communityIdParamsSchema = {
  type: "object",
  additionalProperties: false,
  required: ["communityId"],
  properties: { communityId: { type: "string", maxLength: 64 } },
} as const;

export const communityDetailResourceSchema = {
  type: "object",
  headers: noStoreResponseHeaders(),
  additionalProperties: false,
  required: ["community", "reviewNotes"],
  properties: {
    community: communityRecordSchema,
    reviewNotes: { type: "array", maxItems: 50, items: reviewNoteSchema },
  },
} as const;

export const communityReviewRequestSchema = {
  type: "object",
  additionalProperties: false,
  required: ["decision", "reasonCode"],
  properties: {
    decision: { type: "string", enum: ["verify", "reject"] },
    reasonCode: { type: "string", maxLength: 64 },
    reasonText: {
      ...reasonTextSchema,
      description:
        "Required for `reject` (stored on the community; the applicant reads it in the App). Optional for `verify`.",
    },
  },
} as const;

export const communityReviewResourceSchema = {
  type: "object",
  headers: noStoreResponseHeaders(),
  additionalProperties: false,
  required: ["community", "changed", "notification", "push", "note", "audit"],
  properties: {
    community: communityRecordSchema,
    changed: { type: "boolean" },
    notification: {
      type: "string",
      enum: ["recorded", "duplicate", "skipped", "failed"],
    },
    push: {
      type: "object",
      additionalProperties: false,
      required: ["status", "reasonCode"],
      properties: {
        status: {
          type: "string",
          enum: ["delivered", "suppressed", "unavailable", "skipped"],
        },
        reasonCode: nullableStringSchema,
      },
    },
    note: reviewNoteSchema,
    audit: auditReferenceSchema,
  },
} as const;

const formulaVersionSchema = {
  type: "object",
  additionalProperties: false,
  required: [
    "configVersion",
    "status",
    "scope",
    "effectiveAt",
    "approvedAt",
    "createdAt",
    "updatedAt",
    "parameters",
    "formula",
    "weightRange",
    "priceGuardRules",
  ],
  properties: {
    configVersion: configVersionSchema,
    status: {
      type: "string",
      enum: ["pending_approval", "approved", "retired"],
    },
    scope: nullableStringSchema,
    effectiveAt: nullableDateTimeSchema,
    approvedAt: nullableDateTimeSchema,
    createdAt: dateTimeSchema,
    updatedAt: dateTimeSchema,
    parameters: {
      type: "object",
      additionalProperties: false,
      required: [
        "assetWeights",
        "dailyOutputBudget",
        "referralBoostStatus",
        "communityWeightRange",
        "communityWeights",
        "nftWeight",
        "inviteInitialPower",
      ],
      properties: {
        assetWeights: {
          type: "object",
          additionalProperties: decimalSchema,
        },
        dailyOutputBudget: nullableDecimalSchema,
        referralBoostStatus: {
          type: "string",
          enum: ["pending_approval", "approved"],
        },
        communityWeightRange: {
          anyOf: [
            {
              type: "object",
              additionalProperties: false,
              required: ["min", "max"],
              properties: { min: decimalSchema, max: decimalSchema },
            },
            { type: "null" },
          ],
        },
        communityWeights: {
          anyOf: [
            {
              type: "array",
              items: {
                type: "object",
                additionalProperties: false,
                required: ["communityId", "weight"],
                properties: { communityId: uuidSchema, weight: decimalSchema },
              },
            },
            { type: "null" },
          ],
          description:
            "Weights this version applies when approved; null for versions not created by the console.",
        },
        nftWeight: {
          ...nullableDecimalSchema,
          description: "Placeholder (09 §2 A5); no snapshot reads it.",
        },
        inviteInitialPower: {
          ...nullableDecimalSchema,
          description: "Placeholder (09 §2 A5); no snapshot reads it.",
        },
      },
    },
    formula: looseObjectSchema,
    weightRange: looseObjectSchema,
    priceGuardRules: { type: "array", items: looseObjectSchema },
  },
} as const;

export const formulaVersionListResourceSchema = {
  type: "object",
  headers: noStoreResponseHeaders(),
  additionalProperties: false,
  required: ["items", "approvedVersion", "approval"],
  properties: {
    items: { type: "array", maxItems: 50, items: formulaVersionSchema },
    approvedVersion: { anyOf: [configVersionSchema, { type: "null" }] },
    approval: {
      type: "object",
      additionalProperties: false,
      required: ["available", "reasonCode"],
      properties: {
        available: { type: "boolean" },
        reasonCode: nullableStringSchema,
      },
    },
  },
} as const;

export const formulaDraftRequestSchema = {
  type: "object",
  additionalProperties: false,
  required: ["configVersion", "baseVersion"],
  properties: {
    configVersion: { type: "string", maxLength: 128 },
    baseVersion: {
      type: "string",
      maxLength: 128,
      description:
        "The version whose non-editable parts (expression, price rules, guards, scope) are copied.",
    },
    parameters: {
      type: "object",
      additionalProperties: false,
      description:
        "Every key optional; an omitted key keeps the base version's value. `communityWeights` omitted = the weights approved under the version in force.",
      properties: {
        assetWeights: {
          type: "object",
          additionalProperties: { type: "string", maxLength: 140 },
        },
        dailyOutputBudget: {
          type: ["string", "null"],
          maxLength: 140,
        },
        referralBoostStatus: {
          type: "string",
          enum: ["pending_approval", "approved"],
        },
        communityWeightRange: {
          type: ["object", "null"],
          additionalProperties: false,
          required: ["min", "max"],
          properties: {
            min: { type: "string", maxLength: 140 },
            max: { type: "string", maxLength: 140 },
          },
        },
        communityWeights: {
          type: "array",
          maxItems: 500,
          items: {
            type: "object",
            additionalProperties: false,
            required: ["communityId", "weight"],
            properties: {
              communityId: { type: "string", maxLength: 64 },
              weight: { type: "string", maxLength: 140 },
            },
          },
        },
        nftWeight: {
          type: ["string", "null"],
          maxLength: 140,
        },
        inviteInitialPower: {
          type: ["string", "null"],
          maxLength: 140,
        },
      },
    },
  },
} as const;

export const formulaDraftResourceSchema = {
  type: "object",
  headers: noStoreResponseHeaders(),
  additionalProperties: false,
  required: ["version", "baseVersion", "audit"],
  properties: {
    version: formulaVersionSchema,
    baseVersion: configVersionSchema,
    audit: auditReferenceSchema,
  },
} as const;

export const formulaApproveResourceSchema = {
  type: "object",
  headers: noStoreResponseHeaders(),
  additionalProperties: false,
  required: ["version", "retiredVersion", "audit"],
  properties: {
    version: formulaVersionSchema,
    retiredVersion: { anyOf: [configVersionSchema, { type: "null" }] },
    audit: auditReferenceSchema,
  },
} as const;

export const formulaWithdrawResourceSchema = {
  type: "object",
  headers: noStoreResponseHeaders(),
  additionalProperties: false,
  required: ["version", "audit"],
  properties: {
    version: formulaVersionSchema,
    audit: auditReferenceSchema,
  },
} as const;

export const configVersionParamsSchema = {
  type: "object",
  additionalProperties: false,
  required: ["configVersion"],
  properties: { configVersion: { type: "string", maxLength: 128 } },
} as const;

const memeTokenRecordSchema = {
  type: "object",
  additionalProperties: false,
  required: [
    "memeTokenId",
    "chainId",
    "contractAddress",
    "tokenAddress",
    "name",
    "symbol",
    "status",
    "listing",
    "listingReasonCode",
    "listingReasonText",
    "listingChangedAt",
    "creatorUserId",
    "creatorLoopId",
    "holderCount",
    "tradeCount",
    "sold",
    "graduationNeedsOperator",
    "chainCreatedAt",
    "graduatedAt",
    "createdAt",
  ],
  properties: {
    memeTokenId: uuidSchema,
    chainId: { type: "string" },
    contractAddress: { type: "string" },
    tokenAddress: nullableStringSchema,
    name: { type: "string" },
    symbol: { type: "string" },
    status: {
      type: "string",
      enum: [
        "draft",
        "pending_chain",
        "trading",
        "full",
        "graduated",
        "paused",
      ],
    },
    listing: { type: "string", enum: ["listed", "hidden"] },
    listingReasonCode: nullableStringSchema,
    listingReasonText: nullableStringSchema,
    listingChangedAt: nullableDateTimeSchema,
    creatorUserId: uuidSchema,
    creatorLoopId: nullableStringSchema,
    holderCount: { type: "integer", minimum: 0 },
    tradeCount: { type: "integer", minimum: 0 },
    sold: { type: "string", pattern: "^[0-9]+$" },
    graduationNeedsOperator: { type: "boolean" },
    chainCreatedAt: nullableDateTimeSchema,
    graduatedAt: nullableDateTimeSchema,
    createdAt: dateTimeSchema,
  },
} as const;

export const memeTokensQuerySchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    status: {
      type: "string",
      enum: [
        "draft",
        "pending_chain",
        "trading",
        "full",
        "graduated",
        "paused",
      ],
    },
    listing: { type: "string", enum: ["listed", "hidden"] },
    q: { type: "string", maxLength: 64 },
    cursor: cursorSchema,
    limit: limitSchema,
  },
} as const;

export const memeTokenListResourceSchema = {
  type: "object",
  headers: noStoreResponseHeaders(),
  additionalProperties: false,
  required: ["items", "nextCursor", "pause"],
  properties: {
    items: { type: "array", maxItems: 100, items: memeTokenRecordSchema },
    nextCursor: nullableCursorSchema,
    pause: {
      type: "object",
      additionalProperties: false,
      required: ["available", "reasonCode", "executorAddress"],
      properties: {
        available: { type: "boolean" },
        reasonCode: nullableStringSchema,
        executorAddress: nullableStringSchema,
      },
      description:
        "Whether pause/unpause can sign. `available: false` → grey the buttons and show `reasonCode`.",
    },
  },
} as const;

export const memeTokenIdParamsSchema = {
  type: "object",
  additionalProperties: false,
  required: ["memeTokenId"],
  properties: { memeTokenId: { type: "string", maxLength: 64 } },
} as const;

export const memeListingRequestSchema = {
  type: "object",
  additionalProperties: false,
  required: ["listing", "reasonCode"],
  properties: {
    listing: { type: "string", enum: ["listed", "hidden"] },
    reasonCode: { type: "string", maxLength: 64 },
    reasonText: {
      ...reasonTextSchema,
      description:
        "Required for `hidden`. Shown to App users on the token detail, so write a user-facing sentence.",
    },
  },
} as const;

export const memeListingResourceSchema = {
  type: "object",
  headers: noStoreResponseHeaders(),
  additionalProperties: false,
  required: ["memeToken", "changed", "audit"],
  properties: {
    memeToken: memeTokenRecordSchema,
    changed: { type: "boolean" },
    audit: auditReferenceSchema,
  },
} as const;

export const memePauseRequestSchema = {
  type: "object",
  additionalProperties: false,
  required: ["reasonCode"],
  properties: {
    reasonCode: { type: "string", maxLength: 64 },
    reasonText: reasonTextSchema,
  },
} as const;

export const memePauseResourceSchema = {
  type: "object",
  headers: noStoreResponseHeaders(),
  additionalProperties: false,
  required: [
    "memeTokenId",
    "action",
    "status",
    "transactionHash",
    "executorAddress",
    "audit",
  ],
  properties: {
    memeTokenId: uuidSchema,
    action: { type: "string", enum: ["pause", "unpause"] },
    status: {
      type: "string",
      const: "submitted",
      description:
        "Broadcast, not confirmed. The `meme_event` lane moves the token status when the Paused/Unpaused log is indexed.",
    },
    transactionHash: { type: "string", pattern: "^0x[0-9a-f]{64}$" },
    executorAddress: { type: "string", pattern: "^0x[0-9a-f]{40}$" },
    audit: auditReferenceSchema,
  },
} as const;

export const auditQuerySchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    actor: { type: "string", maxLength: 64 },
    action: { type: "string", maxLength: 64 },
    cursor: cursorSchema,
    limit: limitSchema,
  },
} as const;

export const auditListResourceSchema = {
  type: "object",
  headers: noStoreResponseHeaders(),
  additionalProperties: false,
  required: ["items", "nextCursor"],
  properties: {
    items: { type: "array", maxItems: 100, items: auditRecordSchema },
    nextCursor: nullableCursorSchema,
  },
} as const;

export { reasonCodeSchema };
