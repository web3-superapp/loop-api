import { noStoreResponseHeaders } from "../../core/http/schemas.js";
import { v2ErrorResponseSchema } from "../../core/http/v2-error.js";
import {
  configVersionPatternSource,
  miningDailyOutputUnitKey,
  miningReferencePriceQualities,
  miningFormulaStatuses,
  miningRankAnonymousMemberKey,
  miningRankScopes,
  priceVersionPatternSource,
  unsignedDecimalPatternSource,
} from "../../features/mining/mining-contract.js";
import { miningRankLimit } from "../../features/mining/mining-service.js";
import { v2ContractVersion } from "../../features/meta/product-policy.js";
import { unavailableSchema } from "./launch-schemas.js";
import {
  miningCommunityWeightSchema,
  miningParticipantsSchema,
  miningScopeSchema,
} from "./mining-shared-schemas.js";

/**
 * Route schemas for the V2 mining module (Decisions 0036, 0043, and 0046).
 * Every power, estimate, and rank block is a union of the unavailable
 * projection and an `available` value read from a server snapshot under the
 * formula version in force. Numbers are decimal strings; `scope:
 * development_baseline` marks the Decision 0043 placeholder version so the
 * client labels it as such. The summary, the composition page, and the
 * ranking all publish the same `formula` block, so every page can draw that
 * label from one field.
 */

const opaqueIdPatternSource =
  "^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$";
const assetIdPatternSource = "^eip155:[1-9][0-9]{0,9}:(0x[0-9a-f]{40}|native)$";
const nullableDateTimeSchema = {
  anyOf: [{ type: "string", format: "date-time" }, { type: "null" }],
} as const;
const ruleKeySchema = { type: "string", minLength: 1, maxLength: 128 } as const;
const approvalStatusSchema = {
  type: "string",
  enum: ["pending_approval", "approved"],
} as const;
const decimalSchema = {
  type: "string",
  pattern: unsignedDecimalPatternSource,
} as const;
const scopeSchema = miningScopeSchema;

const snapshotProjectionSchema = {
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
} as const;

const snapshotSchema = {
  anyOf: [unavailableSchema, snapshotProjectionSchema],
} as const;

const decimalOrUnavailableSchema = {
  anyOf: [
    unavailableSchema,
    {
      type: "object",
      additionalProperties: false,
      required: ["status", "value"],
      properties: {
        status: { type: "string", const: "available" },
        value: decimalSchema,
      },
    },
  ],
} as const;

const estimateSchema = {
  anyOf: [
    unavailableSchema,
    {
      type: "object",
      additionalProperties: false,
      required: [
        "status",
        "value",
        "budget",
        "unitKey",
        "budgetStatus",
        "formulaVersion",
        "scope",
      ],
      properties: {
        status: { type: "string", const: "available" },
        value: {
          ...decimalSchema,
          description:
            "budget × accountPower ÷ networkPower, truncated to six fraction digits. An estimate of a placeholder budget, never a claimable amount. Always rendered beside formulaVersion and scope.",
        },
        budget: decimalSchema,
        unitKey: { type: "string", const: miningDailyOutputUnitKey },
        budgetStatus: { type: "string", const: "development_placeholder" },
        formulaVersion: { type: "string", pattern: configVersionPatternSource },
        scope: scopeSchema,
      },
    },
  ],
} as const;

const symbolSchema = {
  anyOf: [{ type: "string", minLength: 1, maxLength: 32 }, { type: "null" }],
  description:
    "The Asset Registry's on-chain symbol() for assetId (BNB for eip155:56:native). null only when the registry has no row for the asset; never a client-side guess.",
} as const;

const formulaStateSchema = {
  description:
    "The formula version in force (approved: configVersion + effectiveAt + scope) or, without one, MINING_FORMULA_BASELINE_PENDING naming the pending version. One definition for the summary, the composition page, and the ranking.",
  anyOf: [
    {
      type: "object",
      additionalProperties: false,
      required: ["status", "configVersion", "effectiveAt", "scope"],
      properties: {
        status: { type: "string", const: "approved" },
        configVersion: { type: "string", pattern: configVersionPatternSource },
        effectiveAt: { type: "string", format: "date-time" },
        scope: scopeSchema,
      },
    },
    {
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
  ],
} as const;

const positionSchema = {
  anyOf: [
    unavailableSchema,
    {
      type: "object",
      additionalProperties: false,
      required: ["status", "position", "power"],
      properties: {
        status: { type: "string", const: "available" },
        position: { type: "integer", minimum: 1 },
        power: decimalSchema,
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
    power: decimalOrUnavailableSchema,
    networkPower: decimalOrUnavailableSchema,
    estimatedToday: estimateSchema,
    accumulated: unavailableSchema,
    claimable: unavailableSchema,
    referralBoost: unavailableSchema,
    formula: formulaStateSchema,
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
    "formula",
    "contractVersion",
  ],
  properties: {
    totalPower: decimalOrUnavailableSchema,
    included: {
      type: "array",
      maxItems: 500,
      items: {
        type: "object",
        additionalProperties: false,
        required: [
          "assetId",
          "symbol",
          "holding",
          "referencePriceUsd",
          "referencePriceQuality",
          "referencePriceProxyAssetId",
          "weight",
          "power",
          "blockNumber",
        ],
        properties: {
          assetId: { type: "string", pattern: assetIdPatternSource },
          symbol: symbolSchema,
          holding: decimalSchema,
          referencePriceUsd: decimalSchema,
          referencePriceQuality: {
            type: "string",
            enum: [...miningReferencePriceQualities],
            description:
              "fresh = the asset's own Provider price; proxied = the price of referencePriceProxyAssetId, a proxy the formula version declares (native BNB via WBNB, Decision 0044).",
          },
          referencePriceProxyAssetId: {
            anyOf: [
              { type: "string", pattern: assetIdPatternSource },
              { type: "null" },
            ],
          },
          weight: {
            ...decimalSchema,
            description:
              "The effective weight: the formula's asset weight, multiplied by the approved community weight when one community binds the asset.",
          },
          power: decimalSchema,
          blockNumber: { type: "string", pattern: "^(0|[1-9][0-9]{0,19})$" },
        },
      },
    },
    excluded: {
      type: "array",
      maxItems: 500,
      description:
        "Assets the account holds that the snapshot did not weight, with the reason re-derived from the same inputs the lane used.",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["assetId", "symbol", "reasonCode"],
        properties: {
          assetId: { type: "string", pattern: assetIdPatternSource },
          symbol: symbolSchema,
          reasonCode: { type: "string", pattern: "^[A-Z][A-Z0-9_]{0,63}$" },
        },
      },
    },
    source: snapshotSchema,
    referencePrice: {
      anyOf: [
        unavailableSchema,
        {
          type: "object",
          additionalProperties: false,
          required: ["status", "priceVersion"],
          properties: {
            status: { type: "string", const: "available" },
            priceVersion: {
              type: "string",
              pattern: priceVersionPatternSource,
            },
          },
        },
      ],
    },
    formula: formulaStateSchema,
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
    estimatedToday: estimateSchema,
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

const rankDisplaySchema = {
  anyOf: [
    {
      type: "object",
      additionalProperties: false,
      required: ["kind", "alias", "publicProfileId"],
      properties: {
        kind: { type: "string", const: "alias" },
        alias: { type: "string", minLength: 1, maxLength: 64 },
        publicProfileId: { type: "string", pattern: opaqueIdPatternSource },
      },
    },
    {
      type: "object",
      additionalProperties: false,
      required: ["kind", "labelKey"],
      properties: {
        kind: { type: "string", const: "anonymous" },
        labelKey: { type: "string", const: miningRankAnonymousMemberKey },
      },
    },
  ],
} as const;

const rankingSchema = {
  anyOf: [
    unavailableSchema,
    {
      type: "object",
      additionalProperties: false,
      required: ["status", "scope", "items", "participants"],
      properties: {
        status: { type: "string", const: "available" },
        scope: { type: "string", const: "users" },
        items: {
          type: "array",
          maxItems: miningRankLimit,
          items: {
            type: "object",
            additionalProperties: false,
            required: ["position", "power", "display", "isSelf"],
            properties: {
              position: {
                anyOf: [{ type: "integer", minimum: 1 }, { type: "null" }],
                description:
                  "rank() among positive powers; null while the power is zero (in the snapshot, not ranked).",
              },
              power: decimalSchema,
              display: rankDisplaySchema,
              isSelf: { type: "boolean" },
            },
          },
        },
        participants: {
          type: "integer",
          minimum: 0,
          description:
            "Accounts with positive power in the snapshot; items may hold more rows (zero-power accounts with position null).",
        },
      },
    },
    {
      type: "object",
      additionalProperties: false,
      required: ["status", "scope", "items", "participants"],
      properties: {
        status: { type: "string", const: "available" },
        scope: { type: "string", const: "communities" },
        items: {
          type: "array",
          maxItems: miningRankLimit,
          items: {
            type: "object",
            additionalProperties: false,
            required: [
              "position",
              "power",
              "community",
              "weight",
              "participants",
            ],
            properties: {
              position: {
                anyOf: [{ type: "integer", minimum: 1 }, { type: "null" }],
                description:
                  "rank() among communities with positive power; null while zero (bound and weighted, not ranked).",
              },
              power: decimalSchema,
              community: {
                type: "object",
                additionalProperties: false,
                required: ["communityId", "name", "boundAssetId"],
                properties: {
                  communityId: {
                    type: "string",
                    pattern: opaqueIdPatternSource,
                  },
                  name: { type: "string", minLength: 1, maxLength: 1024 },
                  boundAssetId: {
                    type: "string",
                    pattern: "^eip155:[1-9][0-9]{0,9}:0x[0-9a-f]{40}$",
                  },
                },
              },
              weight: decimalSchema,
              participants: { type: "integer", minimum: 0 },
            },
          },
        },
        participants: { type: "integer", minimum: 0 },
      },
    },
  ],
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
    "formula",
    "contractVersion",
  ],
  properties: {
    scope: { type: "string", enum: [...miningRankScopes] },
    ranking: {
      ...rankingSchema,
      description:
        "Every account in the snapshot (users) or every bound community with an approved weight (communities), positive power first by rank, zero power after it with position null; at most 100 rows.",
    },
    myPosition: positionSchema,
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
    formula: formulaStateSchema,
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
    "snapshot",
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
    weight: miningCommunityWeightSchema,
    communityPower: {
      ...decimalOrUnavailableSchema,
      description:
        "The non-banned members' power on the community's bound asset under the snapshot (the asset weight × the approved community weight is already inside each member's power).",
    },
    myContribution: decimalOrUnavailableSchema,
    rank: positionSchema,
    participants: miningParticipantsSchema,
    snapshot: snapshotSchema,
    contractVersion: { type: "string", const: v2ContractVersion },
  },
} as const;

const formulaProjectionSchema = {
  type: "object",
  additionalProperties: false,
  required: [
    "configVersion",
    "status",
    "scope",
    "effectiveAt",
    "approvedAt",
    "expressionKey",
    "dailyOutputKey",
    "assetWeights",
    "dailyOutput",
    "weightRange",
    "priceGuardRules",
    "referralBoost",
  ],
  properties: {
    configVersion: { type: "string", pattern: configVersionPatternSource },
    status: { type: "string", enum: [...miningFormulaStatuses] },
    scope: scopeSchema,
    effectiveAt: nullableDateTimeSchema,
    approvedAt: nullableDateTimeSchema,
    expressionKey: ruleKeySchema,
    dailyOutputKey: ruleKeySchema,
    assetWeights: {
      type: "object",
      additionalProperties: decimalSchema,
      propertyNames: { pattern: assetIdPatternSource },
      description:
        "Canonical asset ID → decimal weight. Empty on the product draft; every registered asset at 1 on the development baseline.",
    },
    dailyOutput: {
      anyOf: [
        { type: "null" },
        {
          type: "object",
          additionalProperties: false,
          required: ["status", "budget", "unitKey"],
          properties: {
            status: { type: "string", const: "development_placeholder" },
            budget: decimalSchema,
            unitKey: { type: "string", const: miningDailyOutputUnitKey },
          },
        },
      ],
    },
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
            range: {
              type: "object",
              additionalProperties: false,
              required: ["min", "max"],
              properties: { min: decimalSchema, max: decimalSchema },
              description:
                "Inclusive bounds a reviewed community weight must satisfy under this version. Absent while the range is pending.",
            },
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
    baseline: {
      anyOf: [
        unavailableSchema,
        {
          type: "object",
          additionalProperties: false,
          required: ["status", "configVersion", "effectiveAt", "scope"],
          properties: {
            status: { type: "string", const: "approved" },
            configVersion: {
              type: "string",
              pattern: configVersionPatternSource,
            },
            effectiveAt: { type: "string", format: "date-time" },
            scope: scopeSchema,
          },
        },
      ],
    },
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
