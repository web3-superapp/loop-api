import { miningHourlyBlockSchema } from "./mining-rewards-schemas.js";
import { noStoreResponseHeaders } from "../../core/http/schemas.js";
import { v2ErrorResponseSchema } from "../../core/http/v2-error.js";
import {
  configVersionPatternSource,
  miningDailyOutputUnitKey,
  miningHoldingsSources,
  miningReferencePriceQualities,
  miningFormulaStatuses,
  miningRankAnonymousMemberKey,
  miningRankDisplayRuleKey,
  miningRankPaging,
  miningRankPowerRuleKey,
  miningRankScopes,
  miningReferralRankRuleKey,
  miningSnapshotStatuses,
  priceVersionPatternSource,
  unsignedDecimalPatternSource,
} from "../../features/mining/mining-contract.js";
import {
  communityLogoRefPatternSource,
  storedAvatarRefPatternSource,
} from "../../features/community/community-contract.js";
import { v2ContractVersion } from "../../features/meta/product-policy.js";
import { tokenLogoSchema } from "./token-logo-schema.js";
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

/**
 * The newest run under the version in force (Decision 0057). `complete` is
 * the published snapshot itself; `incomplete` names the holdings the run
 * could not value (nothing was published from it); `invalidated` is a
 * snapshot an operator withdrew, with the reason.
 */
const snapshotAttemptSchema = {
  type: "object",
  additionalProperties: false,
  required: [
    "snapshotId",
    "status",
    "computedAt",
    "reasonCode",
    "unreadInputs",
  ],
  properties: {
    snapshotId: { type: "string", pattern: opaqueIdPatternSource },
    status: { type: "string", enum: [...miningSnapshotStatuses] },
    computedAt: { type: "string", format: "date-time" },
    reasonCode: {
      anyOf: [
        { type: "string", pattern: "^[A-Z][A-Z0-9_]{0,63}$" },
        { type: "null" },
      ],
      description:
        "MINING_SNAPSHOT_INCOMPLETE for an incomplete attempt, the operator's invalidation reason for an invalidated snapshot, null for a complete one.",
    },
    unreadInputs: {
      type: "array",
      maxItems: 500,
      description:
        "Positive weighted holdings the run could not value (non-empty exactly when status is incomplete). An asset listed here is unread, not zero.",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["assetId", "reasonCode"],
        properties: {
          assetId: { type: "string", pattern: assetIdPatternSource },
          reasonCode: { type: "string", pattern: "^[A-Z][A-Z0-9_]{0,63}$" },
        },
      },
    },
  },
} as const;

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
    stale: {
      type: "boolean",
      description:
        "True when a newer run under the same version did not complete (Decision 0057): every number on the page is this snapshot's and is older than latestAttempt.computedAt. Always emitted; optional for older clients.",
    },
    latestAttempt: {
      ...snapshotAttemptSchema,
      description:
        "The newest run under the version in force: this snapshot when stale is false. Always emitted; optional for older clients.",
    },
    holdingsSource: {
      type: "string",
      enum: [...miningHoldingsSources],
      description:
        "Decision 0061: which kinds of observed balance produced the numbers — chain (RPC observations of real addresses, the only value a production stack publishes), mock_seed (Development seed holdings), or mixed. A client renders a demonstration marker for anything other than chain. Always emitted; optional for older clients.",
    },
  },
} as const;

/** The unavailable `snapshot` slot may still explain the newest run. */
const snapshotUnavailableSchema = {
  type: "object",
  additionalProperties: false,
  required: ["status", "reasonCode"],
  properties: {
    ...unavailableSchema.properties,
    latestAttempt: {
      ...snapshotAttemptSchema,
      description:
        "Present when the version in force has a run but no complete snapshot: an incomplete attempt (numbers are MINING_SNAPSHOT_INCOMPLETE) or an invalidated snapshot (MINING_SNAPSHOT_NOT_AVAILABLE).",
    },
  },
} as const;

const snapshotSchema = {
  anyOf: [snapshotUnavailableSchema, snapshotProjectionSchema],
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
    "assetPowerBasis",
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
    assetPowerBasis: {
      type: "string",
      const: "quantity",
      description:
        "Decision 0125: asset power = holding × weight (token quantity, requirer ruling 2026-10-10). referencePrice* fields are still published as the observed fact but do not multiply the power. Snapshots stored before 0125 keep the power they were computed with (holding × referencePriceUsd × weight) until the next snapshot.",
    },
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
    "assetPowerBasis",
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
          "logo",
          "holding",
          "referencePriceUsd",
          "referencePriceQuality",
          "referencePriceProxyAssetId",
          "referencePricePairAddress",
          "weight",
          "power",
          "blockNumber",
        ],
        properties: {
          assetId: { type: "string", pattern: assetIdPatternSource },
          symbol: symbolSchema,
          logo: tokenLogoSchema,
          holding: decimalSchema,
          referencePriceUsd: {
            anyOf: [decimalSchema, { type: "null" }],
            description:
              "Decision 0189: null only when referencePriceQuality is unavailable (a power-list asset whose price could not be read; its power is still holding × weight). Emitted only under MINING_SNAPSHOT_UNPRICED_POWER_EMIT (default off): until then it is always a decimal.",
          },
          referencePriceQuality: {
            type: "string",
            enum: [...miningReferencePriceQualities],
            description:
              "fresh = the asset is the base token of the pair that was read; proxied = the price of referencePriceProxyAssetId, a proxy the formula version declares (native BNB via WBNB, Decision 0044); derived = the asset is the quote token of referencePricePairAddress and the price is that pair's inverted price, accepted only under a reference pricing rule the version declares and only inside its guard band (Decision 0059); unavailable = Decision 0189, no price could be read (referencePriceUsd null, referencePriceReasonCode set; only under MINING_SNAPSHOT_UNPRICED_POWER_EMIT).",
          },
          referencePriceReasonCode: {
            type: "string",
            pattern: "^[A-Z][A-Z0-9_]{0,63}$",
            description:
              "Decision 0189 (optional key; clients must not require it): present only when referencePriceQuality is unavailable — why no price was read (e.g. MINING_PRICE_NOT_FRESH, MINING_PRICE_PAIR_NOT_FOUND).",
          },
          referencePriceProxyAssetId: {
            anyOf: [
              { type: "string", pattern: assetIdPatternSource },
              { type: "null" },
            ],
          },
          referencePricePairAddress: {
            anyOf: [
              { type: "string", pattern: "^0x[0-9a-f]{40}$" },
              { type: "null" },
            ],
            description:
              "The pair the reference price was read from; never null when referencePriceQuality is derived (Decision 0059).",
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
        required: ["assetId", "symbol", "logo", "reasonCode"],
        properties: {
          assetId: { type: "string", pattern: assetIdPatternSource },
          symbol: symbolSchema,
          logo: tokenLogoSchema,
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
    assetPowerBasis: {
      type: "string",
      const: "quantity",
      description:
        "Decision 0125: asset power = holding × weight (token quantity, requirer ruling 2026-10-10). referencePrice* fields are still published as the observed fact but do not multiply the power. Snapshots stored before 0125 keep the power they were computed with (holding × referencePriceUsd × weight) until the next snapshot.",
    },
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
    "hourly",
    "contractVersion",
  ],
  properties: {
    claimable: unavailableSchema,
    claimExecutable: { type: "boolean", const: false },
    estimatedToday: estimateSchema,
    accumulated: unavailableSchema,
    ledger: { type: "array", maxItems: 0, items: {} },
    source: unavailableSchema,
    hourly: miningHourlyBlockSchema,
    contractVersion: { type: "string", const: v2ContractVersion },
  },
} as const;

export const miningRankQuerySchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    scope: { type: "string", enum: [...miningRankScopes] },
    cursor: {
      type: "string",
      minLength: 3,
      maxLength: 1_536,
      pattern: "^[A-Za-z0-9_-]+\\.[A-Za-z0-9_-]+$",
    },
    limit: {
      type: "integer",
      minimum: 1,
      maximum: miningRankPaging.maximumLimit,
      description: `Default ${String(miningRankPaging.defaultLimit)}. Not allowed together with cursor.`,
    },
  },
} as const;

const rankVisibilitySchema = {
  type: "string",
  enum: ["everyone", "self"],
} as const;

const rankDisplaySchema = {
  anyOf: [
    {
      type: "object",
      additionalProperties: false,
      required: ["kind", "alias", "publicProfileId", "audience", "avatarRef"],
      properties: {
        kind: { type: "string", const: "alias" },
        alias: { type: "string", minLength: 1, maxLength: 64 },
        publicProfileId: { type: "string", pattern: opaqueIdPatternSource },
        audience: {
          ...rankVisibilitySchema,
          description:
            "self only on the viewer's own row while anonymous mode is on: the owner sees the alias, everyone else sees the anonymous label (Decision 0049).",
        },
        avatarRef: {
          anyOf: [
            { type: "string", pattern: storedAvatarRefPatternSource },
            { type: "null" },
          ],
          description:
            "Decision 0100: the profile's stored avatar ref, resolved like a profile avatarRef; null when it has none.",
        },
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
          maxItems: miningRankPaging.maximumLimit,
          items: {
            type: "object",
            additionalProperties: false,
            required: [
              "position",
              "power",
              "powerVisibility",
              "display",
              "isSelf",
            ],
            properties: {
              position: {
                anyOf: [{ type: "integer", minimum: 1 }, { type: "null" }],
                description:
                  "rank() among positive powers; null while the power is zero (in the settled hour, not ranked). Always public.",
              },
              power: {
                anyOf: [decimalSchema, { type: "null" }],
                description:
                  "Null only when the row is not the viewer's and its owner set mining power visibility to self (Decision 0049).",
              },
              powerVisibility: {
                ...rankVisibilitySchema,
                description:
                  "The owner's mining_power_visibility setting, published verbatim.",
              },
              display: rankDisplaySchema,
              isSelf: { type: "boolean" },
            },
          },
        },
        participants: {
          type: "integer",
          minimum: 0,
          description:
            "Accounts with positive power in the settled hour; items may hold more rows (zero-power accounts with position null).",
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
          maxItems: miningRankPaging.maximumLimit,
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
                  "rank() among communities with positive power; null while zero (bound, not ranked).",
              },
              power: {
                ...decimalSchema,
                description:
                  "Decision 0148 (S208 revision): the power of the settled hour that belongs to the community — NFT self power of its instances and referral NFT units from its instances × the coefficient, from any holder or inviter (membership not required), plus the members' self power on the bound asset. Accounts the community banned contribute nothing.",
              },
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
              weight: {
                ...decimalSchema,
                description:
                  "Decision 0148: the community's NFT coefficient under the settled hour's parameter version (listed, else the version default, else 0).",
              },
              participants: {
                type: "integer",
                minimum: 0,
                description:
                  "Accounts (members or not, never banned by the community) with positive community power in the hour.",
              },
              avatarRef: {
                anyOf: [
                  { type: "string", pattern: communityLogoRefPatternSource },
                  { type: "null" },
                ],
                description:
                  "S316 / Decision 0188 (optional key; clients must not require it): the community picture, same source and format as the community resources' `logoRef` — `avatar:preset/community-NN` or `logo:media/{mediaId}`; null when unset.",
              },
            },
          },
        },
        participants: { type: "integer", minimum: 0 },
      },
    },
    {
      type: "object",
      additionalProperties: false,
      required: ["status", "scope", "items", "participants", "ruleKey"],
      properties: {
        status: { type: "string", const: "available" },
        scope: { type: "string", const: "referrals" },
        items: {
          type: "array",
          maxItems: miningRankPaging.maximumLimit,
          items: {
            type: "object",
            additionalProperties: false,
            required: ["position", "invitedCount", "display", "isSelf"],
            properties: {
              position: {
                type: "integer",
                minimum: 1,
                description: "rank() by direct invitee count; shared on ties.",
              },
              invitedCount: {
                type: "integer",
                minimum: 1,
                description:
                  "Direct invitees in force (referral_edges depth 1, effective_to null), any validation status. Always public.",
              },
              display: rankDisplaySchema,
              isSelf: { type: "boolean" },
            },
          },
        },
        participants: {
          type: "integer",
          minimum: 0,
          description: "Inviters with at least one direct invitee in force.",
        },
        ruleKey: { type: "string", const: miningReferralRankRuleKey },
      },
    },
  ],
} as const;

const rankMeSchema = {
  anyOf: [
    {
      type: "object",
      additionalProperties: false,
      required: ["rank", "value"],
      properties: {
        rank: { type: "integer", minimum: 1 },
        value: {
          ...decimalSchema,
          description:
            "Power (users, communities) or the direct invitee count (referrals), as a decimal string.",
        },
        communityId: {
          type: "string",
          pattern: opaqueIdPatternSource,
          description:
            "Only on scope=communities: the caller's best-ranked community.",
        },
      },
    },
    { type: "null" },
  ],
  description:
    "Decision 0100: the caller's own place on the requested scope; null when unranked (zero power, no ranked community, no invitee) or while the ranking is unavailable.",
} as const;

export const miningRankResourceSchema = {
  type: "object",
  headers: noStoreResponseHeaders(),
  additionalProperties: false,
  required: [
    "scope",
    "ranking",
    "myPosition",
    "me",
    "nextCursor",
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
        "Decision 0148: every account of the newest settled hour by nft_total_power + asset_total_power (users), every community with a bound asset (communities), positive power first by rank and zero power after it with position null; or every inviter with a direct invitee (referrals). MINING_SNAPSHOT_NOT_AVAILABLE while no hour is settled. One page of at most 50 rows; follow nextCursor.",
    },
    myPosition: positionSchema,
    me: rankMeSchema,
    nextCursor: {
      anyOf: [{ type: "string" }, { type: "null" }],
      description:
        "Next page; null on the last page, after 500 rows in total, or when the cursor secret is not configured.",
    },
    snapshot: {
      ...snapshotSchema,
      description:
        "Decision 0148, users / communities: the settled hour ranked, in the snapshot shape — snapshotId = epochId, computedAt = hourEnd, blockNumber \"0\", blockHash = 0x + the hour's input digest, formulaVersion = the parameter version, priceVersion = mining_hourly:<hourStart>, holdingsSource chain, never stale. Referrals: the snapshot lane's block as before.",
    },
    display: {
      type: "object",
      additionalProperties: false,
      required: ["anonymousMemberKey", "ruleKey", "powerRuleKey"],
      properties: {
        anonymousMemberKey: {
          type: "string",
          const: miningRankAnonymousMemberKey,
        },
        ruleKey: {
          type: "string",
          const: miningRankDisplayRuleKey,
          description:
            "Anonymous mode alone decides whether others see the alias; discoverable is not consulted; the viewer always sees their own alias (Decision 0049).",
        },
        powerRuleKey: {
          type: "string",
          const: miningRankPowerRuleKey,
          description:
            "mining_power_visibility alone decides whether others see the power number; the position is always public; the viewer always sees their own power.",
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
    expressionKey: {
      ...ruleKeySchema,
      description:
        "Decision 0125: mining.rules.formula.holdingTimesWeight (asset power = holding × weight). Versions stored with the retired holdingTimesReferencePriceTimesWeight key are projected with the new key.",
    },
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
      description:
        "Deprecated (Decision 0125): asset power no longer uses the reference price (holding × weight), so these rules only govern which observed price is published beside a holding; do not show them as part of the formula. Kept for client compatibility.",
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
