import { noStoreResponseHeaders } from "../../core/http/schemas.js";
import { v2ErrorResponseSchema } from "../../core/http/v2-error.js";
import {
  anyCaseEvmAddressPatternSource,
  evmAddressPatternSource,
  launchChainIds,
  transactionHashPatternSource,
} from "../../features/chain/chain-contract.js";
import {
  launchConfigVersion,
  launchContractReasonCodeValues,
  launchEntitlementStates,
  launchLiquidityStates,
  launchOperationalStates,
  launchSaleStates,
  launchConfigVersionPatternSource,
  launchEligibilityModes,
  launchEligibilityTiers,
  launchGraduationSteps,
  launchKybStatuses,
  launchListLimits,
  launchOfficialLinkKeys,
  launchProjectKindFilters,
  launchProjectKinds,
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

// Decision 0154: no language or script rule on the token's text.
const launchTokenNameDescription =
  "Decision 0154: any language or script (Chinese, English, mixed, emoji); NFC-normalised and trimmed; at most 64 characters and 64 UTF-8 bytes (the launch factory's on-chain bound: 64 ASCII letters, 21 CJK characters, 16 emoji); control, bidi-override and other format characters refused except the emoji zero-width joiner and tag characters.";
const launchTokenTextDescription =
  "Decision 0154: any language or script; NFC-normalised, CRLF folded to LF, trimmed; at most 2000 characters; line feeds and tabs kept, other control and format characters refused except the emoji zero-width joiner and tag characters.";
const launchTickerDescription =
  "Decision 0154: bound by the deployed launch factories' on-chain `_validTicker` (2–12 of A–Z, 0–9), not by a language policy of LOOP's; lower case is accepted where the pattern allows it and stored upper-cased.";

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

/** Unsigned integer (uint256 and below) as a decimal string; never a JSON number. */
const uintStringSchema = {
  type: "string",
  pattern: "^(0|[1-9][0-9]{0,77})$",
} as const;

const hexQuantityPattern = "^0x(0|[1-9a-f][0-9a-f]{0,63})$";

const nullableHexQuantitySchema = {
  anyOf: [{ type: "string", pattern: hexQuantityPattern }, { type: "null" }],
} as const;

const decimalStringSchema = {
  type: "string",
  pattern: "^(0|[1-9][0-9]{0,77})(\\.[0-9]{1,60})?$",
} as const;

const blockNumberStringSchema = {
  type: "string",
  pattern: "^(0|[1-9][0-9]{0,19})$",
} as const;

const bytes32Schema = {
  type: "string",
  pattern: "^0x[0-9a-f]{64}$",
} as const;

const addressSchema = {
  type: "string",
  pattern: evmAddressPatternSource,
} as const;

const onChainRoundIndexSchema = {
  type: "integer",
  minimum: 0,
  maximum: 65_535,
  description:
    "The contract's roundId (uint16, 06 §4.2). Equals launch_rounds.roundIndex; LOOP's roundId stays the opaque round ID (Decision 0076).",
} as const;

/**
 * Chain snapshot every `available` branch is read at (Decision 0076): one
 * block number and hash per projection.
 */
const snapshotProperties = {
  snapshotBlockNumber: blockNumberStringSchema,
  snapshotBlockHash: bytes32Schema,
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
      description: launchTokenNameDescription,
      type: "string",
      minLength: 1,
      maxLength: maximumLaunchRawTextLength,
    },
    ticker: {
      description: launchTickerDescription,
      type: "string",
      pattern: launchTickerPatternSource,
    },
    narrative: {
      description: launchTokenTextDescription,
      anyOf: [
        { type: "string", minLength: 1, maxLength: maximumLaunchRawTextLength },
        { type: "null" },
      ],
    },
    officialLinks: officialLinksRequestSchema,
    communityId: {
      anyOf: [
        { type: "string", pattern: opaqueIdPatternSource },
        { type: "null" },
      ],
      description:
        "Decision 0125: the community the MEME binds to once it is deployed (the launch2_event lane registers the MEME in the Asset Registry and sets that community's bound asset when it is unbound and the owner still owns it). The caller must be the community's active owner and the community must not be rejected, else 422 VALIDATION_FAILED with detailsSafe.reasonCode LAUNCH_COMMUNITY_NOT_OWNED. On create: absent or null = none (only a named community joins the idempotency digest). On replace: absent keeps the stored value, null clears it, an unchanged ID is not re-checked.",
    },
  },
} as const;

export const createProjectRequestSchema = {
  ...projectValuesRequestSchema,
  properties: {
    ...projectValuesRequestSchema.properties,
    kind: {
      type: "string",
      enum: [...launchProjectKinds],
      description:
        "Decision 0120: ido (default when absent) or launch2 (MEME v2). A first Hooks config save also makes a project launch2; it never goes back. Part of the idempotency digest.",
    },
  },
} as const;

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

/**
 * Decision 0122: a reviewer rejection as the applicant sees it (catalog
 * project or one Hooks config version).
 */
export const hooksLaunchRejectionSchema = {
  type: "object",
  additionalProperties: false,
  required: ["reasonCode", "note", "at"],
  properties: {
    reasonCode: {
      type: "string",
      enum: [
        "incomplete_materials",
        "name_or_ticker_conflict",
        "buyback_recipient_invalid",
        "community_binding_mismatch",
        "other",
      ],
    },
    note: {
      description:
        "The reviewer's note to the applicant (1–500 characters; always present for other, optional otherwise).",
      anyOf: [
        { type: "string", minLength: 1, maxLength: 500 },
        { type: "null" },
      ],
    },
    at: { type: "string", format: "date-time" },
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
    "kind",
    "reviewStatus",
    "reviewReasonCode",
    "reviewReasonText",
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
    kind: {
      type: "string",
      enum: [...launchProjectKinds],
      description:
        "Decision 0120: ido = original Launch application; launch2 = MEME v2 (created with kind launch2, or has a Hooks config draft).",
    },
    reviewStatus: { type: "string", enum: [...launchReviewStatuses] },
    reviewReasonCode: {
      anyOf: [
        { type: "string", pattern: "^[a-z][a-z0-9_]{0,63}$" },
        { type: "null" },
      ],
      description:
        "Machine-readable review reason for logs and client logic. Never render it; render reviewReasonText.",
    },
    reviewReasonText: {
      anyOf: [
        { type: "string", minLength: 1, maxLength: 120 },
        { type: "null" },
      ],
      description:
        "Display projection of reviewReasonCode: one applicant-facing sentence, rendered as-is and never parsed back into a code. Null exactly when reviewReasonCode is null.",
    },
    rejection: {
      description:
        "Decision 0122 (optional in the schema, always present for the owner): the reviewer rejection while reviewStatus is rejected — reasonCode incomplete_materials | name_or_ticker_conflict | buyback_recipient_invalid | community_binding_mismatch | other, the reviewer's note (always present for other) and the time. A rejected project can be edited (PUT) and resubmitted; null otherwise and for non-owners.",
      anyOf: [hooksLaunchRejectionSchema, { type: "null" }],
    },
    communityId: {
      type: "string",
      pattern: opaqueIdPatternSource,
      description:
        "Decision 0125 (optional in the schema): present only when the project names a community (owner and public projections alike); absent means none. Reviewers reject a mismatch with reasonCode community_binding_mismatch.",
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
        "Compare-and-swap version for the owner; null (with reviewReasonCode, reviewReasonText, submittedAt, reviewedAt) when another account reads an approved project.",
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
    kind: {
      type: "string",
      enum: [...launchProjectKindFilters],
      description:
        "Decision 0120: all (default) | ido | launch2. Bound into the cursor when not all.",
    },
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
 * Four-axis projection (03 §8.3, 06 §2), discriminated by `source`
 * (Decision 0076). The `unavailable` branch is the pre-0076 object: every
 * axis the literal `unavailable`, digest and snapshot null. Without a
 * configured contract its reasonCode is LAUNCH_CONTRACT_BASELINE_PENDING and
 * the bytes are unchanged. The `chain` branch carries the 06 axis names read
 * from `getState` at one block, with the contract's own stateTupleDigest and
 * configVersion.
 */
const onChainStateUnavailableSchema = {
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
    reasonCode: {
      type: "string",
      enum: [...launchContractReasonCodeValues],
      description:
        "LAUNCH_CONTRACT_BASELINE_PENDING while no contract is configured (unchanged since Decision 0036); the other values name why a configured contract could not be read (Decision 0076).",
    },
  },
} as const;

const onChainStateAvailableSchema = {
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
    "configVersion",
    "source",
    "reasonCode",
  ],
  properties: {
    saleState: { type: "string", enum: [...launchSaleStates] },
    entitlementState: { type: "string", enum: [...launchEntitlementStates] },
    liquidityState: { type: "string", enum: [...launchLiquidityStates] },
    operationalState: { type: "string", enum: [...launchOperationalStates] },
    stateTupleDigest: {
      ...bytes32Schema,
      description:
        "keccak256(abi.encode(saleId, saleState, entitlementState, liquidityState, operationalState, configVersion)) exactly as getState returned it; never recomputed off chain.",
    },
    ...snapshotProperties,
    configVersion: {
      ...bytes32Schema,
      description:
        "The contract's configVersion (keccak256 of the sale configuration).",
    },
    source: { type: "string", const: "chain" },
    reasonCode: { type: "null" },
  },
} as const;

export const onChainStateSchema = {
  anyOf: [onChainStateUnavailableSchema, onChainStateAvailableSchema],
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
    chainId: {
      type: "string",
      enum: [...launchChainIds],
      description:
        "The launch chain slot the launch was created on (Decision 0038): eip155:56 or, while the Launch contract lives on the BSC testnet, eip155:97. Every other module stays on eip155:56.",
    },
    contractAddress: {
      anyOf: [{ type: "null" }, addressSchema],
      description:
        "Null unless the Launch contract is configured, its code was observed on the launch chain, and this launch's sale is registered on it (Decision 0076).",
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
        live: {
          type: "array",
          maxItems: 200,
          items: launchSummarySchema,
          description:
            "onChainState.saleState = LIVE when onChainState.source is chain (Decision 0077, S83b7); otherwise scheduleStatus = live.",
        },
        upcoming: {
          type: "array",
          maxItems: 200,
          items: launchSummarySchema,
          description:
            "onChainState.saleState = SCHEDULED when onChainState.source is chain (Decision 0077, S83b7); otherwise scheduleStatus = scheduled only.",
        },
        awaitingSchedule: {
          type: "array",
          maxItems: 200,
          items: launchSummarySchema,
          description:
            "scheduleStatus = unscheduled and no on-chain projection (onChainState.source is unavailable): approved catalog entries with no schedule yet; never merged into upcoming.",
        },
        ended: {
          type: "array",
          maxItems: 200,
          items: launchSummarySchema,
          description:
            "onChainState.saleState in ENDED, SUCCEEDED, FAILED, CANCELLED when onChainState.source is chain (Decision 0077, S83b7); otherwise scheduleStatus = ended.",
        },
      },
    },
    graduated: {
      oneOf: [
        unavailableSchema,
        {
          type: "object",
          additionalProperties: false,
          required: ["status", "launches", "indexedBlockNumber"],
          properties: {
            status: { type: "string", const: "available" },
            launches: {
              type: "array",
              maxItems: 50,
              items: launchSummarySchema,
              description:
                "Registered sales whose projected onChainState.liquidityState is LP_LOCKED or COMPLETED (03 §8.3; V3_LIVE is not graduated), latest LPNFTLocked block first (a sale without an indexed LPNFTLocked log last, then by launchId), at most 50. Every item is the same summary as in segments and also appears in its segment.",
            },
            indexedBlockNumber: {
              ...blockNumberStringSchema,
              description:
                "The launch_event lane checkpoint the projections were read against.",
            },
          },
        },
      ],
      description:
        "Decision 0077 S83b7b. unavailable with LAUNCH_CONTRACT_BASELINE_PENDING while no Launch contract is configured (bytes unchanged since Decision 0036); with a contract configured, unavailable names the real reason (the adapter's reason, LAUNCH_ONCHAIN_STATE_NOT_INDEXED without a lane checkpoint, LAUNCH_ONCHAIN_STATE_READ_FAILED when the projections could not be read), otherwise available. Decode reasonCode as any string.",
    },
    myEligibility: unavailableSchema,
    staking: unavailableSchema,
    catalog: {
      type: "object",
      additionalProperties: false,
      required: ["configVersion", "source", "observedAt"],
      properties: {
        configVersion: { type: "string", const: launchConfigVersion },
        source: {
          type: "string",
          const: "loop",
          description:
            "User-facing source label: LOOP's own registry. A stable enum for the client to map to copy, never a database name (Decision 0049).",
        },
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

/** `getSaleConfig` at the four-axis snapshot block (Decision 0076). */
const chainConfigProjectionSchema = {
  type: "object",
  additionalProperties: false,
  required: [
    "status",
    "projectToken",
    "usd1",
    "softCapUsd1",
    "hardCapUsd1",
    "walletProjectCapUsd1",
    "minPurchaseUsd1",
    "protocolFeeBps",
    "liquidityBps",
    "tgeBps",
    "cliffSeconds",
    "vestingSeconds",
    "poolFeeTier",
    "lpLockSeconds",
    "configVersion",
  ],
  properties: {
    status: { type: "string", const: "available" },
    projectToken: addressSchema,
    usd1: addressSchema,
    softCapUsd1: uintStringSchema,
    hardCapUsd1: uintStringSchema,
    walletProjectCapUsd1: uintStringSchema,
    minPurchaseUsd1: uintStringSchema,
    protocolFeeBps: { type: "integer", minimum: 0, maximum: 65_535 },
    liquidityBps: { type: "integer", minimum: 0, maximum: 65_535 },
    tgeBps: { type: "integer", minimum: 0, maximum: 65_535 },
    cliffSeconds: { type: "integer", minimum: 0, maximum: 4_294_967_295 },
    vestingSeconds: { type: "integer", minimum: 0, maximum: 4_294_967_295 },
    poolFeeTier: { type: "integer", minimum: 0, maximum: 16_777_215 },
    lpLockSeconds: { type: "integer", minimum: 0, maximum: 4_294_967_295 },
    configVersion: bytes32Schema,
  },
} as const;

/** One `getRounds` item at the four-axis snapshot block (Decision 0076). */
const chainRoundProjectionSchema = {
  type: "object",
  additionalProperties: false,
  required: [
    "status",
    "roundId",
    "roundIndex",
    "startAt",
    "endAt",
    "priceUsd1PerToken",
    "roundCapUsd1",
    "walletRoundCapUsd1",
    "allowlistRoot",
    "raisedUsd1",
  ],
  properties: {
    status: { type: "string", const: "available" },
    roundId: {
      anyOf: [
        { type: "string", pattern: opaqueIdPatternSource },
        { type: "null" },
      ],
      description:
        "LOOP's opaque round ID for the launch_rounds row with this roundIndex; null when LOOP has no such row.",
    },
    roundIndex: onChainRoundIndexSchema,
    startAt: { type: "string", format: "date-time" },
    endAt: { type: "string", format: "date-time" },
    priceUsd1PerToken: {
      ...uintStringSchema,
      description: "USD1 per whole token, 1e18 = 1 USD1 (06 §4.2).",
    },
    roundCapUsd1: uintStringSchema,
    walletRoundCapUsd1: uintStringSchema,
    allowlistRoot: {
      ...bytes32Schema,
      description: "Merkle root; all zeroes means the round has no allowlist.",
    },
    raisedUsd1: uintStringSchema,
  },
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
    config: {
      anyOf: [
        configProjectionSchema,
        chainConfigProjectionSchema,
        { type: "null" },
      ],
      description:
        "LOOP's configuration slots (status pending_confirmation|confirmed), or, once launch.onChainState.source is chain, the contract's getSaleConfig (status available).",
    },
    configPending: { anyOf: [unavailableSchema, { type: "null" }] },
    rounds: {
      type: "array",
      maxItems: 64,
      items: { anyOf: [roundProjectionSchema, chainRoundProjectionSchema] },
      description:
        "LOOP's round slots, or, once launch.onChainState.source is chain, every getRounds item (status available) at the same block.",
    },
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
      anyOf: [
        {
          type: "object",
          additionalProperties: false,
          required: ["tier", "reasonCode", "snapshotBlock"],
          properties: {
            tier: { type: "null" },
            reasonCode: reasonCodeSchema,
            snapshotBlock: { type: "null" },
          },
        },
        {
          type: "object",
          additionalProperties: false,
          required: [
            "status",
            "tier",
            "reasonCode",
            "snapshotBlock",
            "roundIndex",
            "allowlistRoot",
            "eligibilityProof",
          ],
          properties: {
            status: { type: "string", const: "available" },
            tier: {
              anyOf: [
                { type: "string", enum: [...launchEligibilityTiers] },
                { type: "null" },
              ],
              description: "null when the wallet is not in the allowlist.",
            },
            reasonCode: { anyOf: [reasonCodeSchema, { type: "null" }] },
            snapshotBlock: blockNumberStringSchema,
            roundIndex: onChainRoundIndexSchema,
            allowlistRoot: bytes32Schema,
            eligibilityProof: {
              type: "array",
              maxItems: 64,
              items: bytes32Schema,
              description:
                "Merkle proof for leaf keccak256(abi.encodePacked(wallet)); the buy() eligibilityProof argument verbatim. Empty when the root is zero.",
            },
          },
        },
      ],
      description:
        "The unchanged Decision 0036 object while no contract is configured, the mode is pending, or the evaluation is refused (reasonCode names why, e.g. LAUNCH_ALLOWLIST_ROOT_MISMATCH). status=available (Decision 0077): the round's on-chain allowlistRoot selected LOOP's stored allowlist at snapshotBlock; tier null with LAUNCH_WALLET_NOT_ELIGIBLE means the wallet is not a member; an all-zero root means an open round (tier public, empty proof).",
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
    holders: {
      anyOf: [
        unavailableSchema,
        {
          type: "object",
          additionalProperties: false,
          required: ["status", "holderCount", "indexedBlockNumber"],
          properties: {
            status: { type: "string", const: "available" },
            holderCount: { type: "integer", minimum: 0 },
            indexedBlockNumber: blockNumberStringSchema,
          },
        },
      ],
    },
    myPosition: {
      anyOf: [
        unavailableSchema,
        {
          type: "object",
          additionalProperties: false,
          required: [
            "status",
            "walletId",
            "cumulativeUsd1",
            "purchasedTokens",
            "entitledTokens",
            "claimableTokens",
            "claimedTokens",
            "refundableUsd1",
            "refundedUsd1",
            "snapshotBlockNumber",
            "snapshotBlockHash",
          ],
          properties: {
            status: { type: "string", const: "available" },
            walletId: { type: "string", pattern: opaqueIdPatternSource },
            cumulativeUsd1: uintStringSchema,
            purchasedTokens: uintStringSchema,
            entitledTokens: uintStringSchema,
            claimableTokens: uintStringSchema,
            claimedTokens: uintStringSchema,
            refundableUsd1: uintStringSchema,
            refundedUsd1: uintStringSchema,
            ...snapshotProperties,
          },
          description: "getPosition (06 §4.2 Position) at one block.",
        },
      ],
    },
    walletCap: {
      anyOf: [
        unavailableSchema,
        {
          type: "object",
          additionalProperties: false,
          required: [
            "status",
            "walletProjectCapUsd1",
            "rounds",
            "snapshotBlockNumber",
            "snapshotBlockHash",
          ],
          properties: {
            status: { type: "string", const: "available" },
            walletProjectCapUsd1: uintStringSchema,
            rounds: {
              type: "array",
              maxItems: 64,
              items: {
                type: "object",
                additionalProperties: false,
                required: [
                  "roundIndex",
                  "walletRoundCapUsd1",
                  "cumulativeUsd1",
                ],
                properties: {
                  roundIndex: onChainRoundIndexSchema,
                  walletRoundCapUsd1: uintStringSchema,
                  cumulativeUsd1: {
                    ...uintStringSchema,
                    description: "getRoundPosition for the caller's wallet.",
                  },
                },
              },
            },
            ...snapshotProperties,
          },
        },
      ],
    },
    contractVersion: { type: "string", const: v2ContractVersion },
  },
} as const;

const confirmationStateSchema = {
  type: "string",
  enum: ["pending", "confirmed", "reorged"],
} as const;

/** One observed `Purchased` event (03 §8.3 PurchaseRecord, 06 §3 names). */
const purchaseRecordSchema = {
  type: "object",
  additionalProperties: false,
  required: [
    "purchaseRecordId",
    "walletId",
    "roundId",
    "roundIndex",
    "usd1Amount",
    "tokenAmount",
    "transactionHash",
    "logIndex",
    "blockNumber",
    "blockHash",
    "confirmationState",
    "observedAt",
  ],
  properties: {
    purchaseRecordId: { type: "string", pattern: opaqueIdPatternSource },
    walletId: { type: "string", pattern: opaqueIdPatternSource },
    roundId: {
      anyOf: [
        { type: "string", pattern: opaqueIdPatternSource },
        { type: "null" },
      ],
    },
    roundIndex: onChainRoundIndexSchema,
    usd1Amount: uintStringSchema,
    tokenAmount: uintStringSchema,
    transactionHash: { type: "string", pattern: transactionHashPatternSource },
    logIndex: { type: "integer", minimum: 0 },
    blockNumber: blockNumberStringSchema,
    blockHash: bytes32Schema,
    confirmationState: confirmationStateSchema,
    observedAt: { type: "string", format: "date-time" },
  },
} as const;

/** Frozen project-token claim right after SUCCEEDED (03 §8.3 Entitlement). */
const entitlementRecordSchema = {
  type: "object",
  additionalProperties: false,
  required: [
    "entitlementId",
    "walletId",
    "entitledTokens",
    "claimedTokens",
    "state",
    "frozenAtBlock",
  ],
  properties: {
    entitlementId: { type: "string", pattern: opaqueIdPatternSource },
    walletId: { type: "string", pattern: opaqueIdPatternSource },
    entitledTokens: uintStringSchema,
    claimedTokens: uintStringSchema,
    state: {
      type: "string",
      enum: ["frozen", "partially_claimed", "claimed"],
    },
    frozenAtBlock: { anyOf: [blockNumberStringSchema, { type: "null" }] },
  },
} as const;

/** One Claimed / Refunded log of the caller's wallet (Decision 0087). */
const settlementRecordSchema = {
  type: "object",
  additionalProperties: false,
  required: [
    "settlementRecordId",
    "kind",
    "walletId",
    "assetId",
    "amount",
    "cumulativeAmount",
    "transactionHash",
    "logIndex",
    "blockNumber",
    "blockHash",
    "confirmationState",
    "observedAt",
  ],
  properties: {
    settlementRecordId: { type: "string", pattern: opaqueIdPatternSource },
    kind: {
      type: "string",
      enum: ["claimed", "refunded"],
      description:
        "claimed: a Claimed log (project token received). refunded: a Refunded log (USD1 returned).",
    },
    walletId: { type: "string", pattern: opaqueIdPatternSource },
    assetId: {
      type: "string",
      minLength: 1,
      maxLength: 128,
      description:
        "The project token (claimed) or USD1 (refunded) on the launch chain.",
    },
    amount: {
      ...uintStringSchema,
      description:
        "Claimed.tokenAmount or Refunded.usd1Amount, base units of assetId.",
    },
    cumulativeAmount: {
      ...uintStringSchema,
      description:
        "Claimed.cumulativeClaimed or Refunded.cumulativeRefunded after this log.",
    },
    transactionHash: { type: "string", pattern: transactionHashPatternSource },
    logIndex: { type: "integer", minimum: 0 },
    blockNumber: blockNumberStringSchema,
    blockHash: bytes32Schema,
    confirmationState: confirmationStateSchema,
    observedAt: { type: "string", format: "date-time" },
  },
} as const;

/** Wallet-level refund liability after FAILED/CANCELLED (03 §8.3 RefundLiability). */
const refundRecordSchema = {
  type: "object",
  additionalProperties: false,
  required: [
    "refundLiabilityId",
    "walletId",
    "refundableUsd1",
    "refundedUsd1",
    "state",
    "frozenAtBlock",
  ],
  properties: {
    refundLiabilityId: { type: "string", pattern: opaqueIdPatternSource },
    walletId: { type: "string", pattern: opaqueIdPatternSource },
    refundableUsd1: uintStringSchema,
    refundedUsd1: uintStringSchema,
    state: {
      type: "string",
      enum: ["frozen", "partially_refunded", "refunded"],
    },
    frozenAtBlock: { anyOf: [blockNumberStringSchema, { type: "null" }] },
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
    purchaseRecords: {
      type: "array",
      maxItems: 500,
      items: purchaseRecordSchema,
      description:
        "Always empty while source is unavailable. Otherwise the caller's Purchased events observed by the launch_event lane (reorged rows are kept with confirmationState reorged).",
    },
    entitlements: {
      type: "array",
      maxItems: 500,
      items: entitlementRecordSchema,
      description: "Always empty while source is unavailable.",
    },
    refunds: {
      type: "array",
      maxItems: 500,
      items: refundRecordSchema,
      description: "Always empty while source is unavailable.",
    },
    settlements: {
      type: "array",
      maxItems: 500,
      items: settlementRecordSchema,
      description:
        "Optional (Decision 0087): present only while source is available (absent otherwise, so the unavailable bytes are unchanged). The caller's Claimed (kind claimed) and Refunded (kind refunded) events observed by the launch_event lane, newest first; reorged rows are kept with confirmationState reorged.",
    },
    source: {
      anyOf: [
        unavailableSchema,
        {
          type: "object",
          additionalProperties: false,
          required: ["status", "indexedBlockNumber", "indexedBlockHash"],
          properties: {
            status: { type: "string", const: "available" },
            indexedBlockNumber: blockNumberStringSchema,
            indexedBlockHash: bytes32Schema,
          },
        },
      ],
      description:
        "unavailable until the launch_event lane has a checkpoint and the sale is registered; then the lane's last indexed block (Decision 0077).",
    },
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
  description:
    "Decision 0087: kind selects the contract call. Absent or buy: buy() with walletId, roundId, payAmount (the pre-0087 body). claim / claimRefund: claim(saleId) / claimRefund(saleId) with walletId only; a roundId or payAmount on them is INVALID_REQUEST.",
  anyOf: [
    {
      type: "object",
      additionalProperties: false,
      required: ["walletId", "roundId", "payAmount"],
      properties: {
        kind: {
          type: "string",
          const: "buy",
          description: "Optional (Decision 0087); absent means buy.",
        },
        walletId: { type: "string", pattern: opaqueIdPatternSource },
        roundId: { type: "string", pattern: opaqueIdPatternSource },
        payAmount: {
          type: "string",
          pattern: "^(0|[1-9][0-9]{0,77})(\\.[0-9]{1,60})?$",
          description:
            "USD1 amount as a decimal string; a JSON number is INVALID_REQUEST.",
        },
      },
    },
    {
      type: "object",
      additionalProperties: false,
      required: ["kind", "walletId"],
      properties: {
        kind: { type: "string", enum: ["claim", "claimRefund"] },
        walletId: { type: "string", pattern: opaqueIdPatternSource },
      },
    },
  ],
} as const;

/**
 * The prepared Launch purchase Intent (Decision 0076, reserved for S83b).
 * The route still answers 503 CAPABILITY_UNAVAILABLE; this `201` shape is
 * what a prepare will return once S83b ships, so the client can decode it
 * now. Every 03 §8.2 binding is present; `unsignedTransaction.data` is
 * `buy(saleId, roundId, usd1Amount, minTokenAmount, deadline,
 * eligibilityProof)` in 06 §4.1 order.
 */
export const launchIntentResourceSchema = {
  type: "object",
  headers: noStoreResponseHeaders(),
  additionalProperties: false,
  required: ["launchIntent", "contractVersion"],
  properties: {
    launchIntent: {
      type: "object",
      additionalProperties: false,
      required: [
        "launchIntentId",
        "state",
        "launchId",
        "projectId",
        "walletId",
        "roundId",
        "roundIndex",
        "chainId",
        "contractAddress",
        "quoteAssetId",
        "usd1Amount",
        "expectedTokenAmount",
        "minTokenAmount",
        "walletCumulativeUsd1",
        "deadline",
        "eligibilityProof",
        "configVersion",
        "stateTupleDigest",
        "snapshotBlockNumber",
        "snapshotBlockHash",
        "payloadDigest",
        "unsignedTransaction",
        "expiresAt",
        "createdAt",
      ],
      properties: {
        launchIntentId: { type: "string", pattern: opaqueIdPatternSource },
        kind: {
          type: "string",
          enum: ["buy", "claim", "claimRefund"],
          description:
            "Optional (Decision 0087): present on claim / claimRefund Intents only. Absent means buy, so a purchase keeps its pre-0087 bytes.",
        },
        state: {
          type: "string",
          enum: [
            "prepared",
            "awaiting_signature",
            "submitted",
            "confirmed",
            "reverted",
            "failed",
            "unknown",
            "cancelled",
            "expired",
          ],
          description:
            "Decision 0080: after a broadcast report, submitted settles to confirmed (Purchased log indexed, or success receipt at the launch slot's confirmation depth), reverted (receipt status 0x0), failed (the hash is another transaction), or expired (no receipt after the deadline plus grace). cancelled and unknown are not emitted.",
        },
        launchId: { type: "string", pattern: opaqueIdPatternSource },
        projectId: { type: "string", pattern: opaqueIdPatternSource },
        walletId: { type: "string", pattern: opaqueIdPatternSource },
        roundId: {
          anyOf: [
            { type: "string", pattern: opaqueIdPatternSource },
            { type: "null" },
          ],
          description:
            "The opaque round ID of a buy; null on claim / claimRefund (Decision 0087).",
        },
        roundIndex: {
          anyOf: [onChainRoundIndexSchema, { type: "null" }],
          description:
            "The contract's roundId of a buy; null on claim / claimRefund (Decision 0087).",
        },
        chainId: { type: "string", enum: [...launchChainIds] },
        contractAddress: addressSchema,
        quoteAssetId: { type: "string", minLength: 1, maxLength: 128 },
        usd1Amount: {
          ...uintStringSchema,
          description: "USD1 the wallet pays; 0 on claim / claimRefund.",
        },
        expectedTokenAmount: {
          ...uintStringSchema,
          description:
            "buy: quote() at the snapshot block. claim: getPosition.claimableTokens at the snapshot block. claimRefund: 0.",
        },
        minTokenAmount: uintStringSchema,
        walletCumulativeUsd1: uintStringSchema,
        deadline: { type: "string", format: "date-time" },
        eligibilityProof: { type: "array", maxItems: 64, items: bytes32Schema },
        configVersion: bytes32Schema,
        stateTupleDigest: bytes32Schema,
        ...snapshotProperties,
        payloadDigest: { type: "string", pattern: sha256PatternSource },
        unsignedTransaction: {
          type: "object",
          additionalProperties: false,
          required: ["chainId", "to", "data", "value"],
          properties: {
            chainId: { type: "integer", enum: [56, 97] },
            to: addressSchema,
            data: { type: "string", pattern: "^0x([0-9a-f]{2})*$" },
            value: { type: "string", const: "0x0" },
            from: {
              ...addressSchema,
              description:
                "Optional (Decision 0077): the signing wallet; the device passes the whole object to eth_sendTransaction.",
            },
            gas: { type: "string", pattern: hexQuantityPattern },
            nonce: { type: "string", pattern: hexQuantityPattern },
            type: { type: "string", enum: ["eip1559", "legacy"] },
            maxFeePerGas: nullableHexQuantitySchema,
            maxPriorityFeePerGas: nullableHexQuantitySchema,
            gasPrice: nullableHexQuantitySchema,
          },
        },
        expiresAt: { type: "string", format: "date-time" },
        createdAt: { type: "string", format: "date-time" },
        projectAssetId: {
          type: "string",
          minLength: 1,
          maxLength: 128,
          description:
            "Optional (0077): the project token's asset ID on the launch chain.",
        },
        saleId: {
          ...uintStringSchema,
          description:
            "Optional (0077): the contract's saleId, decimal string.",
        },
        claimableTokens: {
          ...uintStringSchema,
          description:
            "Optional (Decision 0087), claim only: getPosition.claimableTokens at snapshotBlockNumber (project token base units).",
        },
        refundableUsd1: {
          ...uintStringSchema,
          description:
            "Optional (Decision 0087), claimRefund only: getPosition.refundableUsd1 at snapshotBlockNumber (USD1 base units).",
        },
        walletRoundCapUsd1: {
          ...uintStringSchema,
          description:
            "Optional (0077/0088): getRounds walletRoundCapUsd1 of this round at snapshotBlockNumber, for display before signing.",
        },
        walletProjectCapUsd1: {
          ...uintStringSchema,
          description:
            "Optional (0077/0088): getSaleConfig walletProjectCapUsd1 at snapshotBlockNumber, for display before signing.",
        },
        transactionHash: {
          anyOf: [
            { type: "string", pattern: transactionHashPatternSource },
            { type: "null" },
          ],
          description:
            "Optional (0077): the device-reported broadcast hash; pending evidence only. state confirmed means the launch_event lane indexed a Purchased log of it or the reconcile lane read a successful receipt at the launch slot's confirmation depth (Decision 0080).",
        },
        revertReason: {
          anyOf: [
            { type: "string", minLength: 1, maxLength: 256 },
            { type: "null" },
          ],
          description:
            "Optional (Decision 0080): present only when state is reverted. The decoded revert reason when a read surface yields one; null today (public endpoints expose no trace).",
        },
        simulation: {
          type: "object",
          additionalProperties: false,
          required: ["status", "reasonCode"],
          properties: {
            status: {
              type: "string",
              enum: ["passed", "reverted", "unavailable"],
            },
            reasonCode: { anyOf: [reasonCodeSchema, { type: "null" }] },
          },
          description:
            "Optional (0077): eth_call + estimateGas of the exact buy() payload at prepare.",
        },
        policy: {
          type: "object",
          additionalProperties: false,
          required: [
            "configVersion",
            "canaryMaxUsd",
            "valueUsd",
            "priceSource",
          ],
          properties: {
            configVersion: { type: "string", const: "bscWriteCanaryV1" },
            canaryMaxUsd: decimalStringSchema,
            valueUsd: decimalStringSchema,
            priceSource: {
              type: "string",
              const: "usd1_par",
              description: "USD1 is valued at exactly 1 USD for the canary.",
            },
          },
          description:
            "Optional (0077): the Decision 0065 canary facts this Intent was admitted under.",
        },
        signing: {
          type: "object",
          additionalProperties: false,
          required: ["mode", "allowed", "reasonCode"],
          properties: {
            mode: { type: "string", const: "device_eth_send_transaction" },
            allowed: { type: "boolean" },
            reasonCode: { anyOf: [reasonCodeSchema, { type: "null" }] },
          },
          description:
            "Optional (0077): true only in awaiting_signature and before expiresAt.",
        },
      },
    },
    contractVersion: { type: "string", const: v2ContractVersion },
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
    onChain: {
      anyOf: [
        unavailableSchema,
        {
          type: "object",
          additionalProperties: false,
          required: [
            "status",
            "registeredSaleCount",
            "totalRaisedUsd1",
            "lockedLpCount",
            "source",
            "indexedBlockNumber",
            "indexedBlockHash",
          ],
          properties: {
            status: { type: "string", const: "available" },
            registeredSaleCount: { type: "integer", minimum: 0 },
            totalRaisedUsd1: {
              ...uintStringSchema,
              description:
                "Sum of SaleFinalized.totalRaisedUsd1 with outcome SUCCEEDED (USD1 base units).",
            },
            lockedLpCount: {
              type: "integer",
              minimum: 0,
              description: "Sales with a surviving LPNFTLocked event.",
            },
            source: { type: "string", const: "loop_indexer" },
            indexedBlockNumber: blockNumberStringSchema,
            indexedBlockHash: bytes32Schema,
          },
        },
      ],
      description:
        "Optional (Decision 0077): present only while a Launch contract is configured; absent otherwise, so the document is byte-identical to before.",
    },
    source: {
      type: "string",
      const: "loop",
      description:
        "User-facing source label: LOOP's own ledger. A stable enum for the client to map to copy, never a database name (Decision 0049).",
    },
    observedAt: { type: "string", format: "date-time" },
    contractVersion: { type: "string", const: v2ContractVersion },
  },
} as const;

/*
 * Decision 0108: Hooks launch configuration, signing preparation, and
 * deployment-task schemas (ported from the requirer branch, original
 * Decisions 0090/0095/0097). Every amount and timestamp is a decimal string.
 */

const anyCaseBytes32Schema = {
  type: "string",
  pattern: "^0x[0-9a-fA-F]{64}$",
} as const;

const anyCaseAddressSchema = {
  type: "string",
  pattern: anyCaseEvmAddressPatternSource,
} as const;

const unixSecondsStringSchema = {
  type: "string",
  pattern: "^(0|[1-9][0-9]{0,19})$",
} as const;

const hooksLaunchDraftBodySchema = {
  type: "object",
  additionalProperties: false,
  required: [
    "name",
    "ticker",
    "logoAssetUrl",
    "description",
    "links",
    "nftSaleStartAt",
    "buybackRecipient",
  ],
  properties: {
    name: {
      description: launchTokenNameDescription,
      type: "string",
      minLength: 1,
      maxLength: 64,
    },
    ticker: {
      description: launchTickerDescription,
      type: "string",
      pattern: "^[A-Za-z0-9]{2,12}$",
    },
    logoAssetUrl: { type: "string", format: "uri", maxLength: 2_048 },
    description: {
      description: launchTokenTextDescription,
      type: "string",
      maxLength: 2_000,
    },
    links: {
      type: "array",
      maxItems: 8,
      items: { type: "string", format: "uri", maxLength: 2_048 },
    },
    nftSaleStartAt: {
      ...unixSecondsStringSchema,
      description:
        "NFT sale start (unix seconds, decimal string). Must be at least 24 hours after the save.",
    },
    buybackRecipient: {
      ...anyCaseAddressSchema,
      description:
        "Per-project MEME buyback recipient. A configuration value, never an operator or deployer identity.",
    },
  },
} as const;

export const hooksLaunchProjectConfigRequestSchema = {
  type: "object",
  additionalProperties: false,
  required: ["expectedVersion", "config"],
  properties: {
    expectedVersion: {
      type: "integer",
      minimum: 0,
      maximum: 2_147_483_646,
      description:
        "Compare-and-swap: the latest saved version (0 when none). A stale value answers VERSION_CONFLICT.",
    },
    config: hooksLaunchDraftBodySchema,
  },
} as const;

const hooksLaunchFixedEconomicsSchema = {
  type: "object",
  additionalProperties: false,
  required: [
    "chainId",
    "memeTotalSupplyRaw",
    "curveSaleSupplyRaw",
    "initialLiquiditySupplyRaw",
    "graduationReserveUsd1Raw",
    "nftPriceUsd1Raw",
    "nftSaleDurationSeconds",
    "earlyRoundDurationSeconds",
    "perAddressLifetimeBuyCapRaw",
    "curveBuyTaxBps",
    "curveSellTaxBps",
    "officialPoolBuyTaxBps",
    "officialPoolSellTaxBps",
    "lpFee",
    "tickSpacing",
    "buybackOrderUsd1Raw",
    "buybackMinIntervalSeconds",
  ],
  description:
    "Server-derived immutable hooks_launch_v1 economics. Raw amounts are 18-decimal smallest-unit strings; bps and seconds are small bounded integers.",
  properties: {
    chainId: { type: "string", pattern: "^[1-9][0-9]{0,9}$" },
    memeTotalSupplyRaw: uintStringSchema,
    curveSaleSupplyRaw: uintStringSchema,
    initialLiquiditySupplyRaw: uintStringSchema,
    graduationReserveUsd1Raw: uintStringSchema,
    nftPriceUsd1Raw: uintStringSchema,
    nftSaleDurationSeconds: {
      type: "integer",
      minimum: 0,
      description:
        "Decision 0119: the target Factory's nftSaleDuration() when the config was saved (3600 on the BSC Testnet 1-hour Factory; 604800 on mainnet / pre-S141 Factories, whose configHash is unchanged). Part of fixedEconomicsHash.",
    },
    earlyRoundDurationSeconds: { type: "integer", minimum: 0 },
    perAddressLifetimeBuyCapRaw: uintStringSchema,
    curveBuyTaxBps: { type: "integer", minimum: 0, maximum: 10_000 },
    curveSellTaxBps: { type: "integer", minimum: 0, maximum: 10_000 },
    officialPoolBuyTaxBps: { type: "integer", minimum: 0, maximum: 10_000 },
    officialPoolSellTaxBps: { type: "integer", minimum: 0, maximum: 10_000 },
    lpFee: { type: "integer", minimum: 0, maximum: 1_000_000 },
    tickSpacing: { type: "integer", minimum: 1, maximum: 32_767 },
    buybackOrderUsd1Raw: uintStringSchema,
    buybackMinIntervalSeconds: { type: "integer", minimum: 0 },
    // Decision 0131/0132: LoopDynamic templates carry the Hook kind and its
    // immutable parameters; OfficialTax drafts omit both keys.
    officialPoolHookKind: {
      type: "string",
      enum: ["officialTax", "loopDynamic"],
    },
    loopDynamic: {
      type: "object",
      additionalProperties: false,
      required: [
        "router",
        "buyFeePpm",
        "baseSellFeePpm",
        "baseFeeRecipient",
        "priceTiming",
        "routingPolicy",
        "routerRegistryAdmin",
        "excludeBuybackFromRewards",
      ],
      properties: {
        router: addressSchema,
        buyFeePpm: { type: "integer", minimum: 0, maximum: 1_000_000 },
        baseSellFeePpm: { type: "integer", minimum: 0, maximum: 1_000_000 },
        baseFeeRecipient: addressSchema,
        priceTiming: { type: "string", enum: ["PRE_SWAP", "POST_SWAP"] },
        routingPolicy: { type: "string", enum: ["LoopRouterOnly", "Open"] },
        routerRegistryAdmin: addressSchema,
        excludeBuybackFromRewards: { type: "boolean" },
        maxDynamicFeeWad: {
          ...uintStringSchema,
          description:
            "Decision 0144: the Factory's dynamic sell rate cap, a raw 18-decimal integer (200000000000000000 = 20 %; 0 = uncapped). Absent on templates of pre-S193 Factories.",
        },
        // Decision 0152 (S209 generation). The service already emitted both; the response schema
        // lagged behind and fast-json-stringify answered 500 for every S209 draft (S215 finding).
        maxCumulativeBuy: {
          ...uintStringSchema,
          description:
            "Decision 0152: the Factory's per-address curve purchase cap `maxCumulativeBuy()`, a raw MEME integer (5000000000000000000000000 = 5,000,000 MEME). Absent on templates of pre-S209 Factories.",
        },
        buyFeeToken: {
          type: "string",
          enum: ["meme", "usd1"],
          description:
            "Decision 0152: which side the 2 % buy fee is taken from — `usd1` on S209 Factories (hook permission bits 0x10CC), `meme` before.",
        },
      },
    },
  },
} as const;

export const hooksLaunchProjectConfigResourceSchema = {
  type: "object",
  additionalProperties: false,
  required: ["projectId", "version", "templateVersion", "config", "updatedAt"],
  properties: {
    projectId: { type: "string", pattern: opaqueIdPatternSource },
    version: { type: "integer", minimum: 1 },
    templateVersion: { type: "string", const: "hooks_launch_v1" },
    config: {
      type: "object",
      additionalProperties: false,
      required: [
        "templateVersion",
        "templateHash",
        "name",
        "ticker",
        "logoAssetUrl",
        "description",
        "links",
        "nftSaleStartAt",
        "buybackRecipient",
        "fixedEconomics",
        "configHash",
      ],
      properties: {
        templateVersion: { type: "string", const: "hooks_launch_v1" },
        templateHash: bytes32Schema,
        // Decision 0131/0132: present only when the template is LoopDynamic.
        poolHookKind: { type: "string", enum: ["loopDynamic"] },
        name: { type: "string" },
        ticker: { type: "string" },
        logoAssetUrl: { type: "string", format: "uri" },
        description: { type: "string" },
        links: { type: "array", items: { type: "string", format: "uri" } },
        nftSaleStartAt: unixSecondsStringSchema,
        buybackRecipient: addressSchema,
        fixedEconomics: hooksLaunchFixedEconomicsSchema,
        configHash: bytes32Schema,
      },
    },
    updatedAt: { type: "string", format: "date-time" },
  },
} as const;

export const hooksLaunchSigningRequestQuerySchema = {
  type: "object",
  additionalProperties: false,
  required: ["walletId"],
  properties: {
    walletId: { type: "string", pattern: opaqueIdPatternSource },
  },
} as const;

const hooksLaunchRequestFieldsSchema = {
  projectOwner: addressSchema,
  configVersion: { type: "integer", minimum: 1, maximum: 4_294_967_295 },
  configHash: bytes32Schema,
  name: { type: "string", minLength: 1, maxLength: 64 },
  ticker: { type: "string", pattern: "^[A-Z0-9]{2,12}$" },
  nftSaleStart: unixSecondsStringSchema,
  buybackRecipient: addressSchema,
  deadline: unixSecondsStringSchema,
  memeSalt: bytes32Schema,
  nonce: uintStringSchema,
} as const;

const hooksLaunchRequestRequired = [
  "projectOwner",
  "configVersion",
  "configHash",
  "name",
  "ticker",
  "nftSaleStart",
  "buybackRecipient",
  "deadline",
  "memeSalt",
  "nonce",
] as const;

export const hooksLaunchSigningRequestResourceSchema = {
  type: "object",
  additionalProperties: false,
  required: [
    "request",
    "typedData",
    "hookDeployer",
    "hookInitCodeHash",
    "hookSalt",
    "hookAddress",
    "memeDeployer",
    "memeInitCodeHash",
    "memeAddress",
  ],
  properties: {
    request: {
      type: "object",
      additionalProperties: false,
      required: [...hooksLaunchRequestRequired],
      properties: hooksLaunchRequestFieldsSchema,
    },
    typedData: {
      type: "object",
      additionalProperties: true,
      description:
        "EIP-712 typed data (domain 'LOOP Launch Factory' v1, chainId = the launch slot: 97 on BSC Testnet, 56 only under Decision 0150's LAUNCH_MAINNET_ACK, primaryType LaunchRequest) for the project wallet to sign. uint64/uint256 message fields are decimal strings.",
    },
    hookDeployer: addressSchema,
    hookInitCodeHash: bytes32Schema,
    hookSalt: bytes32Schema,
    hookAddress: addressSchema,
    memeDeployer: addressSchema,
    memeInitCodeHash: bytes32Schema,
    memeAddress: addressSchema,
  },
} as const;

export const hooksLaunchDeploymentRequestSchema = {
  type: "object",
  additionalProperties: false,
  required: ["walletId", "request", "hookSalt", "signature"],
  properties: {
    walletId: { type: "string", minLength: 1, maxLength: 128 },
    request: {
      type: "object",
      additionalProperties: false,
      required: [...hooksLaunchRequestRequired],
      properties: {
        ...hooksLaunchRequestFieldsSchema,
        projectOwner: anyCaseAddressSchema,
        configHash: anyCaseBytes32Schema,
        buybackRecipient: anyCaseAddressSchema,
        memeSalt: anyCaseBytes32Schema,
      },
    },
    hookSalt: anyCaseBytes32Schema,
    signature: {
      type: "string",
      pattern: "^0x[0-9a-fA-F]{130}$",
      description: "65-byte low-S EOA EIP-712 signature (v = 27 or 28).",
    },
  },
} as const;

export const hooksLaunchDeploymentParamsSchema = {
  type: "object",
  additionalProperties: false,
  required: ["projectId", "jobId"],
  properties: {
    projectId: { type: "string", pattern: opaqueIdPatternSource },
    jobId: { type: "string", pattern: opaqueIdPatternSource },
  },
} as const;

const hooksLaunchDeploymentStatusSchema = {
  type: "string",
  enum: [
    "awaiting_executor",
    "claimed",
    "broadcast",
    "confirmed",
    "verified",
    "activated",
    "failed",
    "reorged",
    "cancelled",
  ],
} as const;

const nullableTxHashSchema = {
  anyOf: [bytes32Schema, { type: "null" }],
} as const;

const hooksLaunchDeployedAddressesSchema = {
  type: "object",
  additionalProperties: false,
  required: [
    "launchId",
    "meme",
    "hook",
    "nft",
    "curve",
    "gate",
    "escrow",
    "snapshots",
    "graduationAdapter",
    "buybackAdapter",
    "priceRecorder",
    "buybackExecutor",
  ],
  properties: {
    launchId: bytes32Schema,
    meme: addressSchema,
    hook: addressSchema,
    nft: addressSchema,
    curve: addressSchema,
    gate: addressSchema,
    escrow: addressSchema,
    snapshots: addressSchema,
    graduationAdapter: addressSchema,
    buybackAdapter: addressSchema,
    priceRecorder: addressSchema,
    buybackExecutor: addressSchema,
  },
} as const;

const hooksLaunchDeploymentEventSchema = {
  type: "object",
  additionalProperties: false,
  required: [
    "sequence",
    "fromStatus",
    "toStatus",
    "kind",
    "txHash",
    "blockNumber",
    "blockHash",
    "confirmations",
    "errorCode",
    "createdAt",
  ],
  properties: {
    sequence: { type: "integer", minimum: 1 },
    fromStatus: {
      anyOf: [hooksLaunchDeploymentStatusSchema, { type: "null" }],
    },
    toStatus: hooksLaunchDeploymentStatusSchema,
    kind: {
      type: "string",
      pattern: "^[a-z_]{1,40}$",
      description:
        "Executor step: created, claimed, retry_claimed, broadcast, rebroadcast, receipt_found, included, confirmed, reorg_detected, reclaimed_after_reorg, verified, activation_broadcast, activation_included, activation_reorged, activation_reverted, activation_dropped, activation_rejected, activated, failed, lease_taken_over, cancelled. New kinds may be added; render unknown kinds generically.",
    },
    txHash: nullableTxHashSchema,
    blockNumber: {
      anyOf: [
        { type: "string", pattern: "^(0|[1-9][0-9]{0,19})$" },
        { type: "null" },
      ],
      description: "Decimal string.",
    },
    blockHash: nullableTxHashSchema,
    confirmations: {
      anyOf: [{ type: "integer", minimum: 0 }, { type: "null" }],
    },
    errorCode: {
      anyOf: [
        { type: "string", pattern: "^[A-Z0-9_]{1,64}$" },
        { type: "null" },
      ],
    },
    createdAt: { type: "string", format: "date-time" },
  },
} as const;

export const hooksLaunchDeploymentJobSchema = {
  type: "object",
  additionalProperties: false,
  required: [
    "jobId",
    "projectId",
    "configVersion",
    "chainId",
    "factoryAddress",
    "status",
    "memeAddress",
    "hookAddress",
    "txHash",
    "confirmations",
    "activationTxHash",
    "addresses",
    "failure",
    "attemptCount",
    "events",
    "createdAt",
    "updatedAt",
  ],
  properties: {
    jobId: { type: "string", pattern: opaqueIdPatternSource },
    projectId: { type: "string", pattern: opaqueIdPatternSource },
    configVersion: { type: "integer", minimum: 1 },
    chainId: {
      type: "integer",
      enum: [56, 97],
      description:
        "The launch slot the task was signed for (LAUNCH_CHAIN_ID): 97 on BSC Testnet; 56 only while Decision 0150's LAUNCH_MAINNET_ACK is set.",
    },
    factoryAddress: addressSchema,
    status: {
      ...hooksLaunchDeploymentStatusSchema,
      description:
        "Decision 0112. awaiting_executor: verified and recorded, not claimed. claimed: an executor holds the task and re-checks config, approval, deadline and nonces. broadcast: the signed deployLaunch transaction is persisted (txHash) and sent; waiting for confirmations. confirmed: enough confirmations; module verification pending. verified: every module read back and matched; activation pending. activated: LaunchPublicationGate published (NFT sale / curve may accept funds from their own start times). failed: see failure (retryable → the executor retries automatically). reorged: the receipt left the canonical chain; the same transaction is re-sent. cancelled: withdrawn before any claim (does not revoke a signature already shared).",
    },
    memeAddress: {
      ...addressSchema,
      description:
        "Predicted (EIP-712-bound) MEME address; same as addresses.predicted.meme.",
    },
    hookAddress: {
      ...addressSchema,
      description:
        "Predicted (EIP-712-bound) Hook address; same as addresses.predicted.hook.",
    },
    txHash: {
      ...nullableTxHashSchema,
      description:
        "The deployLaunch transaction hash, persisted before it is sent.",
    },
    confirmations: {
      anyOf: [{ type: "integer", minimum: 0 }, { type: "null" }],
      description: "Confirmations of txHash last observed by the executor.",
    },
    activationTxHash: nullableTxHashSchema,
    addresses: {
      type: "object",
      additionalProperties: false,
      required: ["predicted", "deployed"],
      properties: {
        predicted: {
          type: "object",
          additionalProperties: false,
          required: ["meme", "hook"],
          properties: { meme: addressSchema, hook: addressSchema },
        },
        deployed: {
          anyOf: [hooksLaunchDeployedAddressesSchema, { type: "null" }],
          description:
            "Read back from the Factory after verification; null before verified.",
        },
      },
    },
    failure: {
      anyOf: [
        {
          type: "object",
          additionalProperties: false,
          required: ["code", "retryable"],
          properties: {
            code: { type: "string", pattern: "^[A-Z0-9_]{1,64}$" },
            retryable: { type: "boolean" },
          },
        },
        { type: "null" },
      ],
    },
    attemptCount: { type: "integer", minimum: 0 },
    events: {
      type: "array",
      maxItems: 100,
      items: hooksLaunchDeploymentEventSchema,
      description: "Most recent 100 executor events, oldest first.",
    },
    createdAt: { type: "string", format: "date-time" },
    updatedAt: { type: "string", format: "date-time" },
  },
} as const;

/**
 * Decision 0108 + 0120: the owner's draft plus what the creator flow needs
 * to resume after a cold start (approval, newest task, sale-start lead).
 */
export const hooksLaunchProjectConfigReadSchema = {
  type: "object",
  additionalProperties: false,
  required: [
    "draft",
    "approval",
    "latestDeployment",
    "minSaleLeadSeconds",
    "contractVersion",
  ],
  properties: {
    draft: {
      anyOf: [hooksLaunchProjectConfigResourceSchema, { type: "null" }],
    },
    approval: {
      description:
        "Decision 0120: null without a draft. approved only when the operator approved this draft version with the same configHash; a newer save is awaiting_approval again.",
      anyOf: [
        {
          type: "object",
          additionalProperties: false,
          required: ["configVersion", "status", "approvedAt"],
          properties: {
            configVersion: {
              type: "integer",
              minimum: 1,
              maximum: 2_147_483_647,
            },
            status: {
              description:
                "Decision 0122 adds rejected: a reviewer rejected this version (see rejection); saving a new version (expectedVersion = this version) resubmits it as awaiting_approval.",
              type: "string",
              enum: ["awaiting_approval", "approved", "rejected"],
            },
            approvedAt: {
              anyOf: [
                { type: "string", format: "date-time" },
                { type: "null" },
              ],
            },
            rejection: {
              description:
                "Decision 0122 (optional in the schema, always present in answers): non-null exactly when status is rejected.",
              anyOf: [hooksLaunchRejectionSchema, { type: "null" }],
            },
          },
        },
        { type: "null" },
      ],
    },
    latestDeployment: {
      description:
        "Decision 0120: the newest deployment task of the project (any config version, any status), as GET hooks-deployments/{jobId}; null when none.",
      anyOf: [hooksLaunchDeploymentJobSchema, { type: "null" }],
    },
    minSaleLeadSeconds: {
      type: "integer",
      minimum: 4_200,
      maximum: 2_592_000,
      description:
        "Decision 0120: HOOKS_LAUNCH_MIN_SALE_LEAD_SECONDS. A save accepts nftSaleStartAt ≥ server now + this value (400 otherwise).",
    },
    buybackRecipientFixed: {
      description:
        "Decision 0122 (optional in the schema, always present in answers): always true — the buyback recipient is fixed by the platform; the App shows fixedBuybackRecipient read-only and sends it unchanged as config.buybackRecipient.",
      type: "boolean",
      const: true,
    },
    fixedBuybackRecipient: {
      description:
        "Decision 0122 (optional in the schema, always present in answers): LAUNCH2_BUYBACK_RECIPIENT (lower-case). null = not configured: every save, signing request and submission is 503 HOOKS_BUYBACK_RECIPIENT_UNAVAILABLE.",
      anyOf: [addressSchema, { type: "null" }],
    },
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

export const launchIntentParamsSchema = {
  type: "object",
  additionalProperties: false,
  required: ["launchId", "launchIntentId"],
  properties: {
    launchId: { type: "string", pattern: opaqueIdPatternSource },
    launchIntentId: { type: "string", pattern: opaqueIdPatternSource },
  },
} as const;

export const launchIntentReportRequestSchema = {
  type: "object",
  additionalProperties: false,
  required: ["txHash"],
  properties: {
    txHash: {
      type: "string",
      pattern: "^0x[0-9a-fA-F]{64}$",
      description: "The hash eth_sendTransaction returned on the device.",
    },
  },
} as const;

export const launchIntentReportResourceSchema = {
  ...launchIntentResourceSchema,
} as const;

export const eligibilityQuerySchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    roundIndex: {
      type: "integer",
      minimum: 0,
      maximum: 65_535,
      description:
        "Optional (Decision 0077): the on-chain round to evaluate. Default: the round open now, else the next one, else the last.",
    },
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

/** Decision 0122: the signing request can refuse a non-fixed recipient. */
export const hooksSigningRequestErrors = {
  ...launchReadErrors,
  422: v2ErrorResponseSchema(["VALIDATION_FAILED"]),
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

/**
 * Errors of the Launch Intent prepare (Decision 0077). `detailsSafe.reasonCode`
 * names the rule; the full list is in docs/frontend-v2-launch-api.md §S83b.
 */
export const launchIntentErrors = {
  ...launchCommandErrors,
  403: v2ErrorResponseSchema(["PERMISSION_DENIED", "POLICY_BLOCKED"]),
  409: v2ErrorResponseSchema([
    "ACCOUNT_BOOTSTRAP_REQUIRED",
    "DATA_STALE",
    "IDEMPOTENCY_CONFLICT",
    "INSUFFICIENT_BALANCE",
    "VERSION_CONFLICT",
  ]),
} as const;
