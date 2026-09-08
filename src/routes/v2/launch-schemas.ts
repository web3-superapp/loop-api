import { noStoreResponseHeaders } from "../../core/http/schemas.js";
import { v2ErrorResponseSchema } from "../../core/http/v2-error.js";
import {
  launchChainId,
  launchConfigVersion,
  launchConfigVersionPatternSource,
  launchEligibilityModes,
  launchEligibilityTiers,
  launchGraduationSteps,
  launchKybStatuses,
  launchListLimits,
  launchOfficialLinkKeys,
  launchProjectListFilters,
  launchReviewStatuses,
  launchScheduleStatuses,
  launchSlotStatuses,
  launchTickerPatternSource,
  maximumLaunchLinkLength,
  maximumLaunchRawTextLength,
  opaqueIdPatternSource,
  sha256PatternSource,
  venueMilestoneMarketTypes,
  venueMilestoneStates,
  venueMilestoneVenues,
} from "../../features/launch/launch-contract.js";
import { v2ContractVersion } from "../../features/meta/product-policy.js";
import { cursorSchema, nullableCursorSchema } from "./community-schemas.js";

/**
 * Route schemas for the V2 launch module (Decision 0036). Every bounded
 * object rejects unknown properties; every amount is a string; the four
 * on-chain axes are literal `unavailable` constants so the artifact itself
 * documents that no contract baseline exists.
 */

const reasonCodeSchema = {
  type: "string",
  pattern: "^[A-Z][A-Z0-9_]{0,63}$",
} as const;

export const unavailableSchema = {
  type: "object",
  additionalProperties: false,
  required: ["status", "reasonCode"],
  properties: {
    status: { type: "string", const: "unavailable" },
    reasonCode: reasonCodeSchema,
  },
} as const;

const nullableDateTimeSchema = {
  anyOf: [{ type: "string", format: "date-time" }, { type: "null" }],
} as const;

const nullableLinkSchema = {
  anyOf: [
    {
      type: "string",
      minLength: 9,
      maxLength: maximumLaunchLinkLength,
      pattern: "^https://",
    },
    { type: "null" },
  ],
} as const;

const officialLinksResponseSchema = {
  type: "object",
  additionalProperties: false,
  required: [...launchOfficialLinkKeys],
  properties: Object.fromEntries(
    launchOfficialLinkKeys.map((key) => [key, nullableLinkSchema]),
  ) as Record<
    (typeof launchOfficialLinkKeys)[number],
    typeof nullableLinkSchema
  >,
} as const;

const officialLinksRequestSchema = {
  type: "object",
  additionalProperties: false,
  properties: Object.fromEntries(
    launchOfficialLinkKeys.map((key) => [key, nullableLinkSchema]),
  ) as Record<
    (typeof launchOfficialLinkKeys)[number],
    typeof nullableLinkSchema
  >,
} as const;

const projectValuesRequestSchema = {
  type: "object",
  additionalProperties: false,
  required: ["name", "ticker", "narrative"],
  properties: {
    name: {
      type: "string",
      minLength: 1,
      maxLength: maximumLaunchRawTextLength,
    },
    ticker: { type: "string", pattern: launchTickerPatternSource },
    narrative: {
      anyOf: [
        { type: "string", minLength: 1, maxLength: maximumLaunchRawTextLength },
        { type: "null" },
      ],
    },
    officialLinks: officialLinksRequestSchema,
  },
} as const;

export const createProjectRequestSchema = projectValuesRequestSchema;

export const replaceProjectRequestSchema = {
  type: "object",
  additionalProperties: false,
  required: ["expectedVersion", "project"],
  properties: {
    expectedVersion: {
      type: "integer",
      minimum: 1,
      description:
        "Compare-and-swap version from the last read. A stale value is VERSION_CONFLICT; an identical retry returns the committed resource.",
    },
    project: projectValuesRequestSchema,
  },
} as const;

const projectProjectionSchema = {
  type: "object",
  additionalProperties: false,
  required: [
    "projectId",
    "name",
    "ticker",
    "narrative",
    "officialLinks",
    "materialVersion",
    "reviewStatus",
    "reviewReasonCode",
    "kyb",
    "attachments",
    "submittedAt",
    "reviewedAt",
    "launchId",
    "version",
    "createdAt",
    "updatedAt",
    "configVersion",
  ],
  properties: {
    projectId: { type: "string", pattern: opaqueIdPatternSource },
    name: {
      type: "string",
      minLength: 1,
      maxLength: maximumLaunchRawTextLength,
    },
    ticker: { type: "string", pattern: launchTickerPatternSource },
    narrative: {
      anyOf: [
        { type: "string", minLength: 1, maxLength: maximumLaunchRawTextLength },
        { type: "null" },
      ],
    },
    officialLinks: officialLinksResponseSchema,
    materialVersion: { type: "integer", minimum: 1 },
    reviewStatus: { type: "string", enum: [...launchReviewStatuses] },
    reviewReasonCode: {
      anyOf: [
        { type: "string", pattern: "^[a-z][a-z0-9_]{0,63}$" },
        { type: "null" },
      ],
    },
    kyb: {
      type: "object",
      additionalProperties: false,
      required: ["status", "state", "reasonCode"],
      properties: {
        status: { type: "string", const: "unavailable" },
        state: { type: "string", enum: [...launchKybStatuses] },
        reasonCode: reasonCodeSchema,
      },
    },
    attachments: unavailableSchema,
    submittedAt: nullableDateTimeSchema,
    reviewedAt: nullableDateTimeSchema,
    launchId: {
      anyOf: [
        { type: "string", pattern: opaqueIdPatternSource },
        { type: "null" },
      ],
    },
    version: {
      anyOf: [{ type: "integer", minimum: 1 }, { type: "null" }],
      description:
        "Compare-and-swap version for the owner; null (with reviewReasonCode, submittedAt, reviewedAt) when another account reads an approved project.",
    },
    createdAt: { type: "string", format: "date-time" },
    updatedAt: { type: "string", format: "date-time" },
    configVersion: { type: "string", const: launchConfigVersion },
  },
} as const;

export const projectResourceSchema = {
  type: "object",
  headers: noStoreResponseHeaders(),
  additionalProperties: false,
  required: ["project", "contractVersion"],
  properties: {
    project: projectProjectionSchema,
    contractVersion: { type: "string", const: v2ContractVersion },
  },
} as const;

export const projectListQuerySchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    status: { type: "string", enum: [...launchProjectListFilters] },
    cursor: cursorSchema,
    limit: { type: "integer", minimum: 1, maximum: launchListLimits.maximum },
  },
} as const;

export const projectListResourceSchema = {
  type: "object",
  headers: noStoreResponseHeaders(),
  additionalProperties: false,
  required: ["items", "nextCursor", "contractVersion"],
  properties: {
    items: {
      type: "array",
      maxItems: launchListLimits.maximum,
      items: projectProjectionSchema,
    },
    nextCursor: nullableCursorSchema,
    contractVersion: { type: "string", const: v2ContractVersion },
  },
} as const;

/**
 * Four-axis projection (03 §8.3). Axis names are fixed; values are the
 * literal `unavailable` and the tuple digest / snapshot block are null until
 * the 02 contract baseline defines them.
 */
export const onChainStateSchema = {
  type: "object",
  additionalProperties: false,
  required: [
    "saleState",
    "entitlementState",
    "liquidityState",
    "operationalState",
    "stateTupleDigest",
    "snapshotBlockNumber",
    "snapshotBlockHash",
    "source",
    "reasonCode",
  ],
  properties: {
    saleState: { type: "string", const: "unavailable" },
    entitlementState: { type: "string", const: "unavailable" },
    liquidityState: { type: "string", const: "unavailable" },
    operationalState: { type: "string", const: "unavailable" },
    stateTupleDigest: { type: "null" },
    snapshotBlockNumber: { type: "null" },
    snapshotBlockHash: { type: "null" },
    source: { type: "string", const: "unavailable" },
    reasonCode: { type: "string", const: "LAUNCH_CONTRACT_BASELINE_PENDING" },
  },
} as const;

const launchSummarySchema = {
  type: "object",
  additionalProperties: false,
  required: [
    "launchId",
    "projectId",
    "name",
    "ticker",
    "chainId",
    "contractAddress",
    "configDigest",
    "scheduleStatus",
    "onChainState",
    "configVersion",
    "createdAt",
  ],
  properties: {
    launchId: { type: "string", pattern: opaqueIdPatternSource },
    projectId: { type: "string", pattern: opaqueIdPatternSource },
    name: {
      type: "string",
      minLength: 1,
      maxLength: maximumLaunchRawTextLength,
    },
    ticker: { type: "string", pattern: launchTickerPatternSource },
    chainId: { type: "string", const: launchChainId },
    contractAddress: {
      type: "null",
      description:
        "Always null: no Launch contract has been deployed, audited, or verified.",
    },
    configDigest: {
      anyOf: [
        { type: "string", pattern: sha256PatternSource },
        { type: "null" },
      ],
    },
    scheduleStatus: { type: "string", enum: [...launchScheduleStatuses] },
    onChainState: onChainStateSchema,
    configVersion: {
      anyOf: [
        { type: "string", pattern: launchConfigVersionPatternSource },
        { type: "null" },
      ],
      description:
        "The confirmed configuration version, or null while pending.",
    },
    createdAt: { type: "string", format: "date-time" },
  },
} as const;

export const overviewResourceSchema = {
  type: "object",
  headers: noStoreResponseHeaders(),
  additionalProperties: false,
  required: [
    "segments",
    "graduated",
    "myEligibility",
    "staking",
    "catalog",
    "contractVersion",
  ],
  properties: {
    segments: {
      type: "object",
      additionalProperties: false,
      required: ["live", "upcoming", "awaitingSchedule", "ended"],
      properties: {
        live: { type: "array", maxItems: 200, items: launchSummarySchema },
        upcoming: {
          type: "array",
          maxItems: 200,
          items: launchSummarySchema,
          description: "scheduleStatus = scheduled only.",
        },
        awaitingSchedule: {
          type: "array",
          maxItems: 200,
          items: launchSummarySchema,
          description:
            "scheduleStatus = unscheduled: approved catalog entries with no schedule yet; never merged into upcoming.",
        },
        ended: { type: "array", maxItems: 200, items: launchSummarySchema },
      },
    },
    graduated: unavailableSchema,
    myEligibility: unavailableSchema,
    staking: unavailableSchema,
    catalog: {
      type: "object",
      additionalProperties: false,
      required: ["configVersion", "source", "observedAt"],
      properties: {
        configVersion: { type: "string", const: launchConfigVersion },
        source: { type: "string", const: "loop_db" },
        observedAt: { type: "string", format: "date-time" },
      },
    },
    contractVersion: { type: "string", const: v2ContractVersion },
  },
} as const;

const configSlotSchema = {
  anyOf: [
    unavailableSchema,
    {
      type: "object",
      additionalProperties: false,
      required: ["status", "value"],
      properties: {
        status: { type: "string", const: "confirmed" },
        value: { type: "string", minLength: 1, maxLength: 256 },
      },
    },
  ],
} as const;

const configProjectionSchema = {
  type: "object",
  additionalProperties: false,
  required: ["configVersion", "status", "effectiveAt", "slots"],
  properties: {
    configVersion: {
      type: "string",
      pattern: launchConfigVersionPatternSource,
    },
    status: { type: "string", enum: [...launchSlotStatuses] },
    effectiveAt: nullableDateTimeSchema,
    slots: {
      type: "object",
      additionalProperties: false,
      required: [
        "walletRoundCap",
        "walletProjectCap",
        "feeBps",
        "softCap",
        "hardCap",
        "tge",
        "vesting",
        "tierModeV1",
      ],
      properties: {
        walletRoundCap: configSlotSchema,
        walletProjectCap: configSlotSchema,
        feeBps: configSlotSchema,
        softCap: configSlotSchema,
        hardCap: configSlotSchema,
        tge: configSlotSchema,
        vesting: configSlotSchema,
        tierModeV1: configSlotSchema,
      },
    },
  },
} as const;

const roundProjectionSchema = {
  type: "object",
  additionalProperties: false,
  required: [
    "roundId",
    "roundIndex",
    "configVersion",
    "status",
    "startsAt",
    "endsAt",
    "priceUsd1",
    "eligibilityTier",
    "walletRoundCapRaw",
  ],
  properties: {
    roundId: { type: "string", pattern: opaqueIdPatternSource },
    roundIndex: { type: "integer", minimum: 1 },
    configVersion: {
      type: "string",
      pattern: launchConfigVersionPatternSource,
    },
    status: { type: "string", enum: [...launchSlotStatuses] },
    startsAt: nullableDateTimeSchema,
    endsAt: nullableDateTimeSchema,
    priceUsd1: {
      anyOf: [
        {
          type: "string",
          pattern: "^(0|[1-9][0-9]{0,77})(\\.[0-9]{1,60})?$",
        },
        { type: "null" },
      ],
    },
    eligibilityTier: {
      anyOf: [
        { type: "string", enum: [...launchEligibilityTiers] },
        { type: "null" },
      ],
    },
    walletRoundCapRaw: {
      anyOf: [
        { type: "string", pattern: "^(0|[1-9][0-9]{0,77})$" },
        { type: "null" },
      ],
    },
  },
} as const;

export const launchDetailResourceSchema = {
  type: "object",
  headers: noStoreResponseHeaders(),
  additionalProperties: false,
  required: [
    "launch",
    "project",
    "config",
    "configPending",
    "rounds",
    "graduation",
    "market",
    "holders",
    "contractVersion",
  ],
  properties: {
    launch: launchSummarySchema,
    project: {
      type: "object",
      additionalProperties: false,
      required: [
        "projectId",
        "name",
        "ticker",
        "narrative",
        "officialLinks",
        "materialVersion",
      ],
      properties: {
        projectId: { type: "string", pattern: opaqueIdPatternSource },
        name: {
          type: "string",
          minLength: 1,
          maxLength: maximumLaunchRawTextLength,
        },
        ticker: { type: "string", pattern: launchTickerPatternSource },
        narrative: {
          anyOf: [
            {
              type: "string",
              minLength: 1,
              maxLength: maximumLaunchRawTextLength,
            },
            { type: "null" },
          ],
        },
        officialLinks: officialLinksResponseSchema,
        materialVersion: { type: "integer", minimum: 1 },
      },
    },
    config: { anyOf: [configProjectionSchema, { type: "null" }] },
    configPending: { anyOf: [unavailableSchema, { type: "null" }] },
    rounds: { type: "array", maxItems: 64, items: roundProjectionSchema },
    graduation: {
      type: "object",
      additionalProperties: false,
      required: ["steps", "poolEvidence"],
      properties: {
        steps: {
          type: "array",
          minItems: launchGraduationSteps.length,
          maxItems: launchGraduationSteps.length,
          items: {
            type: "object",
            additionalProperties: false,
            required: ["step", "status"],
            properties: {
              step: { type: "string", enum: [...launchGraduationSteps] },
              status: { type: "string", const: "pending" },
            },
          },
        },
        poolEvidence: unavailableSchema,
      },
    },
    market: unavailableSchema,
    holders: unavailableSchema,
    contractVersion: { type: "string", const: v2ContractVersion },
  },
} as const;

export const eligibilityResourceSchema = {
  type: "object",
  headers: noStoreResponseHeaders(),
  additionalProperties: false,
  required: [
    "launchId",
    "mode",
    "result",
    "configVersion",
    "effectiveAt",
    "dependsOnStaking",
    "contractVersion",
  ],
  properties: {
    launchId: { type: "string", pattern: opaqueIdPatternSource },
    mode: { type: "string", enum: [...launchEligibilityModes] },
    result: {
      type: "object",
      additionalProperties: false,
      required: ["tier", "reasonCode", "snapshotBlock"],
      properties: {
        tier: { type: "null" },
        reasonCode: reasonCodeSchema,
        snapshotBlock: { type: "null" },
      },
    },
    configVersion: {
      anyOf: [
        { type: "string", pattern: launchConfigVersionPatternSource },
        { type: "null" },
      ],
    },
    effectiveAt: nullableDateTimeSchema,
    dependsOnStaking: {
      type: "boolean",
      const: false,
      description: "Eligibility never depends on staking (main-agent ruling).",
    },
    contractVersion: { type: "string", const: v2ContractVersion },
  },
} as const;

export const holdersResourceSchema = {
  type: "object",
  headers: noStoreResponseHeaders(),
  additionalProperties: false,
  required: [
    "launchId",
    "holders",
    "myPosition",
    "walletCap",
    "contractVersion",
  ],
  properties: {
    launchId: { type: "string", pattern: opaqueIdPatternSource },
    holders: unavailableSchema,
    myPosition: unavailableSchema,
    walletCap: unavailableSchema,
    contractVersion: { type: "string", const: v2ContractVersion },
  },
} as const;

export const historyResourceSchema = {
  type: "object",
  headers: noStoreResponseHeaders(),
  additionalProperties: false,
  required: [
    "launchId",
    "purchaseRecords",
    "entitlements",
    "refunds",
    "source",
    "contractVersion",
  ],
  properties: {
    launchId: { type: "string", pattern: opaqueIdPatternSource },
    purchaseRecords: { type: "array", maxItems: 0, items: {} },
    entitlements: { type: "array", maxItems: 0, items: {} },
    refunds: { type: "array", maxItems: 0, items: {} },
    source: unavailableSchema,
    contractVersion: { type: "string", const: v2ContractVersion },
  },
} as const;

export const milestonesResourceSchema = {
  type: "object",
  headers: noStoreResponseHeaders(),
  additionalProperties: false,
  required: ["projectId", "items", "contractVersion"],
  properties: {
    projectId: { type: "string", pattern: opaqueIdPatternSource },
    items: {
      type: "array",
      maxItems: 64,
      items: {
        type: "object",
        additionalProperties: false,
        required: [
          "venueMilestoneId",
          "venue",
          "marketType",
          "state",
          "evidence",
          "version",
          "updatedAt",
        ],
        properties: {
          venueMilestoneId: {
            anyOf: [
              { type: "string", pattern: opaqueIdPatternSource },
              { type: "null" },
            ],
            description:
              "null for an implicit PREPARING row: the track has no stored record yet.",
          },
          venue: { type: "string", enum: [...venueMilestoneVenues] },
          marketType: { type: "string", enum: [...venueMilestoneMarketTypes] },
          state: { type: "string", enum: [...venueMilestoneStates] },
          evidence: {
            type: "object",
            additionalProperties: false,
            required: ["digest", "recordedAt", "observedAt", "reviewer"],
            properties: {
              digest: {
                anyOf: [
                  { type: "string", pattern: sha256PatternSource },
                  { type: "null" },
                ],
              },
              recordedAt: {
                ...nullableDateTimeSchema,
                description:
                  "Server clock when the reviewer recorded the evidence.",
              },
              observedAt: {
                ...nullableDateTimeSchema,
                description:
                  "Operator-supplied platform time the evidence became verifiable; null when not supplied. Never derived from recordedAt.",
              },
              reviewer: {
                anyOf: [
                  { type: "string", pattern: "^[a-z][a-z0-9_.-]{0,63}$" },
                  { type: "null" },
                ],
              },
            },
          },
          version: {
            type: "integer",
            minimum: 0,
            description: "0 for an implicit PREPARING row.",
          },
          updatedAt: {
            ...nullableDateTimeSchema,
            description: "null for an implicit PREPARING row.",
          },
        },
      },
    },
    contractVersion: { type: "string", const: v2ContractVersion },
  },
} as const;

/**
 * Documented request shape of the Launch purchase Intent (03 §8.2). The
 * route answers 503 CAPABILITY_UNAVAILABLE unconditionally in this step; the
 * schema exists so the client and the artifact agree on the eventual shape.
 */
export const launchIntentRequestSchema = {
  type: "object",
  additionalProperties: false,
  required: ["walletId", "roundId", "payAmount"],
  properties: {
    walletId: { type: "string", pattern: opaqueIdPatternSource },
    roundId: { type: "string", pattern: opaqueIdPatternSource },
    payAmount: {
      type: "string",
      pattern: "^(0|[1-9][0-9]{0,77})(\\.[0-9]{1,60})?$",
      description:
        "USD1 amount as a decimal string; a JSON number is INVALID_REQUEST.",
    },
  },
} as const;

export const stakeResourceSchema = {
  type: "object",
  headers: noStoreResponseHeaders(),
  additionalProperties: false,
  required: ["stake", "executable", "contractVersion"],
  properties: {
    stake: unavailableSchema,
    executable: { type: "boolean", const: false },
    contractVersion: { type: "string", const: v2ContractVersion },
  },
} as const;

const countsSchema = <T extends readonly string[]>(keys: T) =>
  ({
    type: "object",
    additionalProperties: false,
    required: [...keys],
    properties: Object.fromEntries(
      keys.map((key) => [key, { type: "integer", minimum: 0 }]),
    ) as Record<T[number], { readonly type: "integer"; readonly minimum: 0 }>,
  }) as const;

export const economyResourceSchema = {
  type: "object",
  headers: noStoreResponseHeaders(),
  additionalProperties: false,
  required: [
    "projects",
    "launches",
    "confirmedRoundCount",
    "totalSupply",
    "distributed",
    "ecosystemTax",
    "source",
    "observedAt",
    "contractVersion",
  ],
  properties: {
    projects: countsSchema(launchReviewStatuses),
    launches: countsSchema(launchScheduleStatuses),
    confirmedRoundCount: { type: "integer", minimum: 0 },
    totalSupply: unavailableSchema,
    distributed: unavailableSchema,
    ecosystemTax: unavailableSchema,
    source: { type: "string", const: "loop_db" },
    observedAt: { type: "string", format: "date-time" },
    contractVersion: { type: "string", const: v2ContractVersion },
  },
} as const;

export const projectIdParamsSchema = {
  type: "object",
  additionalProperties: false,
  required: ["projectId"],
  properties: {
    projectId: { type: "string", pattern: opaqueIdPatternSource },
  },
} as const;

export const launchIdParamsSchema = {
  type: "object",
  additionalProperties: false,
  required: ["launchId"],
  properties: {
    launchId: { type: "string", pattern: opaqueIdPatternSource },
  },
} as const;

export const launchReadErrors = {
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

export const launchCommandErrors = {
  ...launchReadErrors,
  403: v2ErrorResponseSchema(["PERMISSION_DENIED", "POLICY_BLOCKED"]),
  409: v2ErrorResponseSchema([
    "ACCOUNT_BOOTSTRAP_REQUIRED",
    "DATA_STALE",
    "IDEMPOTENCY_CONFLICT",
    "VERSION_CONFLICT",
  ]),
  422: v2ErrorResponseSchema(["VALIDATION_FAILED"]),
} as const;
