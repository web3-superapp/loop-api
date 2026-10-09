import {
  communityWeightReviewStatuses,
  configVersionPatternSource,
  miningFormulaScopes,
  unsignedDecimalPatternSource,
} from "../../features/mining/mining-contract.js";

/**
 * Route-schema fragments shared by the mining module and the community-side
 * `miningPower` projection (Decision 0045). They live apart from
 * `mining-schemas.ts` and `community-schemas.ts` so that neither file has to
 * import the other: `launch-schemas.ts` already depends on the community
 * cursor schemas, and a cycle through it would leave those undefined at
 * load time. Nothing here imports another route-schema module.
 */

const reasonCodeSchema = {
  type: "string",
  pattern: "^[A-Z][A-Z0-9_]{0,63}$",
} as const;

const miningUnavailableSchema = {
  type: "object",
  additionalProperties: false,
  required: ["status", "reasonCode"],
  properties: {
    status: { type: "string", const: "unavailable" },
    reasonCode: reasonCodeSchema,
  },
} as const;

/**
 * The version's self-declared scope, published on the summary, the rules,
 * and every community-side `miningPower` from the same `formula.scope`.
 */
export const miningScopeSchema = {
  anyOf: [{ type: "string", enum: [...miningFormulaScopes] }, { type: "null" }],
  description:
    "The version's self-declared scope. development_baseline is the Decision 0043 placeholder (weights 1, placeholder daily budget); null is a product version.",
} as const;

/**
 * A community's reviewed weight under the version in force. One definition
 * for `GET /v2/mining/communities/{id}.weight` and the community-side
 * `miningPower.weight`.
 */
export const miningCommunityWeightSchema = {
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
        reasonCode: {
          ...reasonCodeSchema,
          description:
            "COMMUNITY_ASSET_NOT_BOUND without a bound asset (nothing to review); COMMUNITY_WEIGHT_PENDING_REVIEW for a bound community without an approved weight.",
        },
        reviewStatus: {
          type: "string",
          enum: [...communityWeightReviewStatuses],
          description:
            "pending_review pairs with COMMUNITY_WEIGHT_PENDING_REVIEW; not_applicable pairs with COMMUNITY_ASSET_NOT_BOUND (Decision 0046).",
        },
      },
    },
  ],
} as const;

/** Members with positive power on the bound asset; shared like the weight. */
export const miningParticipantsSchema = {
  anyOf: [
    miningUnavailableSchema,
    {
      type: "object",
      additionalProperties: false,
      required: ["status", "count"],
      properties: {
        status: { type: "string", const: "available" },
        count: { type: "integer", minimum: 0 },
      },
    },
  ],
} as const;
