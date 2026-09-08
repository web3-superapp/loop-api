import { noStoreResponseHeaders } from "../../core/http/schemas.js";
import { v2ErrorResponseSchema } from "../../core/http/v2-error.js";
import {
  configVersionPatternSource,
  miningFormulaStatuses,
  miningRankAnonymousMemberKey,
  miningRankScopes,
  priceVersionPatternSource,
  unsignedDecimalPatternSource,
} from "../../features/mining/mining-contract.js";
import { v2ContractVersion } from "../../features/meta/product-policy.js";
import { unavailableSchema } from "./launch-schemas.js";

/**
 * Route schemas for the V2 mining module (Decision 0036). Every power,
 * reward, and rank block is the unavailable projection; the rules resource
 * carries only versioned rule *keys* (no weight numbers, no reward promise).
 */

const opaqueIdPatternSource =
  "^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$";
const nullableDateTimeSchema = {
  anyOf: [{ type: "string", format: "date-time" }, { type: "null" }],
} as const;
const ruleKeySchema = { type: "string", minLength: 1, maxLength: 128 } as const;
const approvalStatusSchema = {
  type: "string",
  enum: ["pending_approval", "approved"],
} as const;

const snapshotSchema = {
  anyOf: [
    unavailableSchema,
    {
      type: "object",
      additionalProperties: false,
      required: [
        "snapshotId",
        "blockNumber",
        "blockHash",
        "formulaVersion",
        "priceVersion",
        "computedAt",
      ],
      properties: {
        snapshotId: { type: "string", pattern: opaqueIdPatternSource },
        blockNumber: { type: "string", pattern: "^(0|[1-9][0-9]{0,19})$" },
        blockHash: { type: "string", pattern: "^0x[0-9a-f]{64}$" },
        formulaVersion: { type: "string", pattern: configVersionPatternSource },
        priceVersion: { type: "string", pattern: priceVersionPatternSource },
        computedAt: { type: "string", format: "date-time" },
      },
    },
  ],
} as const;

export const miningSummaryResourceSchema = {
  type: "object",
  headers: noStoreResponseHeaders(),
  additionalProperties: false,
  required: [
    "power",
    "networkPower",
    "estimatedToday",
    "accumulated",
    "claimable",
    "referralBoost",
    "formula",
    "snapshot",
    "contractVersion",
  ],
  properties: {
    power: unavailableSchema,
    networkPower: unavailableSchema,
    estimatedToday: unavailableSchema,
    accumulated: unavailableSchema,
    claimable: unavailableSchema,
    referralBoost: unavailableSchema,
    formula: {
      type: "object",
      additionalProperties: false,
      required: ["status", "reasonCode", "pendingVersion"],
      properties: {
        status: { type: "string", const: "unavailable" },
        reasonCode: {
          type: "string",
          const: "MINING_FORMULA_BASELINE_PENDING",
        },
        pendingVersion: {
          anyOf: [
            { type: "string", pattern: configVersionPatternSource },
            { type: "null" },
          ],
        },
      },
    },
    snapshot: snapshotSchema,
    contractVersion: { type: "string", const: v2ContractVersion },
  },
} as const;

export const miningAssetsResourceSchema = {
  type: "object",
  headers: noStoreResponseHeaders(),
  additionalProperties: false,
  required: [
    "totalPower",
    "included",
    "excluded",
    "source",
    "referencePrice",
    "contractVersion",
  ],
  properties: {
    totalPower: unavailableSchema,
    included: { type: "array", maxItems: 0, items: {} },
    excluded: { type: "array", maxItems: 0, items: {} },
    source: unavailableSchema,
    referencePrice: unavailableSchema,
    contractVersion: { type: "string", const: v2ContractVersion },
  },
} as const;

export const miningRewardsResourceSchema = {
  type: "object",
  headers: noStoreResponseHeaders(),
  additionalProperties: false,
  required: [
    "claimable",
    "claimExecutable",
    "estimatedToday",
    "accumulated",
    "ledger",
    "source",
    "contractVersion",
  ],
  properties: {
    claimable: unavailableSchema,
    claimExecutable: { type: "boolean", const: false },
    estimatedToday: unavailableSchema,
    accumulated: unavailableSchema,
    ledger: { type: "array", maxItems: 0, items: {} },
    source: unavailableSchema,
    contractVersion: { type: "string", const: v2ContractVersion },
  },
} as const;

export const miningRankQuerySchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    scope: { type: "string", enum: [...miningRankScopes] },
  },
} as const;

export const miningRankResourceSchema = {
  type: "object",
  headers: noStoreResponseHeaders(),
  additionalProperties: false,
  required: [
    "scope",
    "ranking",
    "myPosition",
    "snapshot",
    "display",
    "contractVersion",
  ],
  properties: {
    scope: { type: "string", enum: [...miningRankScopes] },
    ranking: unavailableSchema,
    myPosition: unavailableSchema,
    snapshot: snapshotSchema,
    display: {
      type: "object",
      additionalProperties: false,
      required: ["anonymousMemberKey", "ruleKey"],
      properties: {
        anonymousMemberKey: {
          type: "string",
          const: miningRankAnonymousMemberKey,
        },
        ruleKey: {
          type: "string",
          const: "mining.rank.display.aliasOrAnonymous",
          description:
            "A ranked account is shown by alias only when its profile is discoverable and not in anonymous mode; otherwise by the anonymous member label.",
        },
      },
    },
    contractVersion: { type: "string", const: v2ContractVersion },
  },
} as const;

export const miningCommunityParamsSchema = {
  type: "object",
  additionalProperties: false,
  required: ["communityId"],
  properties: {
    communityId: { type: "string", pattern: opaqueIdPatternSource },
  },
} as const;

export const miningCommunityResourceSchema = {
  type: "object",
  headers: noStoreResponseHeaders(),
  additionalProperties: false,
  required: [
    "community",
    "weight",
    "communityPower",
    "myContribution",
    "rank",
    "participants",
    "contractVersion",
  ],
  properties: {
    community: {
      type: "object",
      additionalProperties: false,
      required: ["communityId", "name", "boundAssetId"],
      properties: {
        communityId: { type: "string", pattern: opaqueIdPatternSource },
        name: { type: "string", minLength: 1, maxLength: 1024 },
        boundAssetId: {
          anyOf: [
            {
              type: "string",
              pattern: "^eip155:[1-9][0-9]{0,9}:0x[0-9a-f]{40}$",
            },
            { type: "null" },
          ],
        },
      },
    },
    weight: {
      anyOf: [
        {
          type: "object",
          additionalProperties: false,
          required: ["status", "value", "configVersion", "reviewedAt"],
          properties: {
            status: { type: "string", const: "approved" },
            value: { type: "string", pattern: unsignedDecimalPatternSource },
            configVersion: {
              type: "string",
              pattern: configVersionPatternSource,
            },
            reviewedAt: { type: "string", format: "date-time" },
          },
        },
        {
          type: "object",
          additionalProperties: false,
          required: ["status", "reasonCode", "reviewStatus"],
          properties: {
            status: { type: "string", const: "unavailable" },
            reasonCode: { type: "string", pattern: "^[A-Z][A-Z0-9_]{0,63}$" },
            reviewStatus: { type: "string", const: "pending_review" },
          },
        },
      ],
    },
    communityPower: unavailableSchema,
    myContribution: unavailableSchema,
    rank: unavailableSchema,
    participants: unavailableSchema,
    contractVersion: { type: "string", const: v2ContractVersion },
  },
} as const;

const formulaProjectionSchema = {
  type: "object",
  additionalProperties: false,
  required: [
    "configVersion",
    "status",
    "effectiveAt",
    "approvedAt",
    "expressionKey",
    "dailyOutputKey",
    "weightRange",
    "priceGuardRules",
    "referralBoost",
  ],
  properties: {
    configVersion: { type: "string", pattern: configVersionPatternSource },
    status: { type: "string", enum: [...miningFormulaStatuses] },
    effectiveAt: nullableDateTimeSchema,
    approvedAt: nullableDateTimeSchema,
    expressionKey: ruleKeySchema,
    dailyOutputKey: ruleKeySchema,
    weightRange: {
      type: "object",
      additionalProperties: false,
      required: ["loop", "community", "reviewFactorKeys"],
      properties: {
        loop: {
          type: "object",
          additionalProperties: false,
          required: ["status", "descriptionKey"],
          properties: {
            status: approvalStatusSchema,
            descriptionKey: ruleKeySchema,
          },
        },
        community: {
          type: "object",
          additionalProperties: false,
          required: ["status", "descriptionKey"],
          properties: {
            status: approvalStatusSchema,
            descriptionKey: ruleKeySchema,
          },
        },
        reviewFactorKeys: { type: "array", maxItems: 16, items: ruleKeySchema },
      },
    },
    priceGuardRules: {
      type: "array",
      maxItems: 16,
      items: {
        type: "object",
        additionalProperties: false,
        required: ["ruleKey", "status"],
        properties: { ruleKey: ruleKeySchema, status: approvalStatusSchema },
      },
    },
    referralBoost: {
      type: "object",
      additionalProperties: false,
      required: ["status"],
      properties: { status: approvalStatusSchema },
    },
  },
} as const;

export const miningRulesResourceSchema = {
  type: "object",
  headers: noStoreResponseHeaders(),
  additionalProperties: false,
  required: [
    "approved",
    "pendingApproval",
    "baseline",
    "referral",
    "contractVersion",
  ],
  properties: {
    approved: { anyOf: [formulaProjectionSchema, { type: "null" }] },
    pendingApproval: {
      type: "array",
      maxItems: 50,
      items: formulaProjectionSchema,
    },
    baseline: unavailableSchema,
    referral: {
      type: "object",
      additionalProperties: false,
      required: ["configVersion", "effectiveAt", "levels"],
      properties: {
        configVersion: { type: "string", const: "referralRulesV1" },
        effectiveAt: { type: "string", format: "date-time" },
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
              boostPercent: { type: "string", pattern: "^(0|[1-9][0-9]?)$" },
              descriptionKey: ruleKeySchema,
            },
          },
        },
      },
    },
    contractVersion: { type: "string", const: v2ContractVersion },
  },
} as const;

export const miningReadErrors = {
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
