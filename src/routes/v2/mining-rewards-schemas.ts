import { opaqueIdPatternSource } from "../../core/ids/opaque-id.js";
import { v2ErrorResponseSchema } from "../../core/http/v2-error.js";
import { noStoreResponseHeaders } from "../../core/http/schemas.js";
import {
  miningClaimStates,
  miningDisplayStates,
} from "../../features/mining/hourly-settlement-contract.js";
import { v2ContractVersion } from "../../features/meta/product-policy.js";
import { cursorSchema, nullableCursorSchema } from "./community-schemas.js";

/**
 * Decision 0116 route schemas: the `hourly` block of `GET /v2/mining/rewards`,
 * the epoch history, the claim list, and claim prepare / report. LOOP
 * amounts are raw integer strings (`*Raw`, 18 decimals, `decimals: 18`);
 * powers are decimal strings (1e18 fixed point rendered); never JSON numbers
 * for money.
 */

const rawSchema = {
  type: "string",
  pattern: "^(0|[1-9][0-9]{0,77})$",
} as const;
const powerSchema = {
  type: "string",
  pattern: "^(0|[1-9][0-9]{0,77})(\\.[0-9]{1,18})?$",
} as const;
const reasonCodeSchema = {
  type: "string",
  pattern: "^[A-Z][A-Z0-9_]{2,63}$",
} as const;
const nullableReasonCodeSchema = {
  anyOf: [reasonCodeSchema, { type: "null" }],
} as const;
const opaqueIdSchema = {
  type: "string",
  pattern: opaqueIdPatternSource,
} as const;
const nullableOpaqueIdSchema = {
  anyOf: [opaqueIdSchema, { type: "null" }],
} as const;
const dateTimeSchema = { type: "string", format: "date-time" } as const;
const nullableDateTimeSchema = {
  anyOf: [dateTimeSchema, { type: "null" }],
} as const;
const assetIdSchema = {
  type: "string",
  pattern: "^eip155:[1-9][0-9]{0,9}:0x[0-9a-f]{40}$",
} as const;
const addressSchema = { type: "string", pattern: "^0x[0-9a-f]{40}$" } as const;
const hexQuantitySchema = {
  type: "string",
  pattern: "^0x(0|[1-9a-f][0-9a-f]{0,63})$",
} as const;
const txHashSchema = { type: "string", pattern: "^0x[0-9a-f]{64}$" } as const;
const contractVersionSchema = {
  type: "string",
  const: v2ContractVersion,
} as const;

function object(
  properties: Record<string, unknown>,
  description?: string,
): Record<string, unknown> {
  return {
    type: "object",
    additionalProperties: false,
    required: Object.keys(properties),
    properties,
    ...(description === undefined ? {} : { description }),
  };
}

function nullable(schema: Record<string, unknown>) {
  return { anyOf: [schema, { type: "null" }] };
}

export const miningClaimSchema = object({
  claimId: opaqueIdSchema,
  walletId: opaqueIdSchema,
  status: {
    type: "string",
    enum: [...miningClaimStates],
    description:
      "claimable (voucher issued) → submitting (hash reported, not mined) → confirming (mined, < MINING_CLAIM_CONFIRMATIONS) → succeeded; failed (reverted); expired (deadline passed, nonce unused, or another voucher of the same nonce landed).",
  },
  chainId: { type: "string", pattern: "^eip155:[1-9][0-9]{0,9}$" },
  chainReference: { anyOf: [{ type: "integer" }, { type: "null" }] },
  contractAddress: addressSchema,
  cumulativeAmountRaw: rawSchema,
  amountRaw: {
    ...rawSchema,
    description:
      "The amount this claim pays: the confirmed Claimed amount once succeeded, otherwise the expected delta.",
  },
  nonce: rawSchema,
  deadline: dateTimeSchema,
  transactionHash: nullable(txHashSchema),
  blockNumber: nullable(rawSchema),
  failureReasonCode: nullableReasonCodeSchema,
  createdAt: dateTimeSchema,
  updatedAt: dateTimeSchema,
});

const levelSchema = object({
  level: { type: "integer", minimum: 1, maximum: 5 },
  ratioBps: { type: "integer", minimum: 0, maximum: 10_000 },
  effectiveMembers: { type: "integer", minimum: 0 },
  nftPower: powerSchema,
  assetPower: powerSchema,
  totalPower: powerSchema,
  nftUnitsByCommunity: {
    type: "array",
    items: object({
      communityId: nullableOpaqueIdSchema,
      units: powerSchema,
    }),
    description:
      "Equivalent NFT units (count × level ratio, by source community). Reward computation only: never NFT holdings, never early-purchase eligibility.",
  },
});

export const miningHourlyBlockSchema = object(
  {
    serverTime: dateTimeSchema,
    decimals: { type: "integer", const: 18 },
    displayState: { type: "string", enum: [...miningDisplayStates] },
    reasonCode: nullableReasonCodeSchema,
    totals: nullable(
      object({
        settledRaw: rawSchema,
        claimedRaw: rawSchema,
        claimableRaw: {
          ...rawSchema,
          description:
            "settled − claimed (confirmed on chain). The Claim button uses only this; the minute display never changes it.",
        },
      }),
    ),
    lastHour: nullable(
      object({
        epochId: opaqueIdSchema,
        hourStart: dateTimeSchema,
        hourEnd: dateTimeSchema,
        settledAt: nullableDateTimeSchema,
        nftRewardRaw: rawSchema,
        assetRewardRaw: rawSchema,
        totalRewardRaw: rawSchema,
      }),
    ),
    display: nullable(
      object(
        {
          windowStart: nullableDateTimeSchema,
          windowEnd: nullableDateTimeSchema,
          totalRaw: rawSchema,
          perMinuteRaw: rawSchema,
          completedMinutes: { type: "integer", minimum: 0, maximum: 60 },
          displayedRaw: rawSchema,
          nextUpdateAt: nullableDateTimeSchema,
        },
        "displayedRaw = floor(totalRaw × m / 60) with m = floor((now − windowStart) / 60 s) capped at 60; minute 60 shows totalRaw exactly.",
      ),
    ),
    tracks: nullable(
      object({
        nft: object({
          realNftCount: rawSchema,
          selfPower: powerSchema,
          referralPower: powerSchema,
          totalPower: powerSchema,
          networkPower: powerSchema,
          budgetRaw: rawSchema,
          rewardRaw: rawSchema,
          holdings: {
            type: "array",
            items: object({
              instanceId: opaqueIdSchema,
              communityId: nullableOpaqueIdSchema,
              countAtEnd: rawSchema,
              power: powerSchema,
            }),
          },
        }),
        asset: object({
          selfPower: powerSchema,
          referralPower: powerSchema,
          totalPower: powerSchema,
          networkPower: powerSchema,
          budgetRaw: rawSchema,
          rewardRaw: rawSchema,
          holdings: {
            type: "array",
            description:
              "Decision 0123: power = hour-average of balance × Mining Weight (token quantity, no price) for hours settled under a quantity-basis parameter version; hours settled before it keep their valuation-basis numbers.",
            items: object({
              assetId: assetIdSchema,
              balanceAtEndRaw: rawSchema,
              power: powerSchema,
            }),
          },
          excludedAssets: {
            type: "array",
            items: object({
              assetId: assetIdSchema,
              reasonCode: reasonCodeSchema,
            }),
          },
        }),
      }),
    ),
    referral: nullable(
      object({
        levels: { type: "array", minItems: 5, maxItems: 5, items: levelSchema },
      }),
    ),
    parameters: nullable(
      object({
        versionId: opaqueIdSchema,
        configVersion: { type: "string" },
        effectiveFrom: dateTimeSchema,
        referralRatiosBps: {
          type: "array",
          minItems: 5,
          maxItems: 5,
          items: { type: "integer", minimum: 0, maximum: 10_000 },
        },
        minimumClaimRaw: rawSchema,
      }),
    ),
    claim: object(
      {
        executable: { type: "boolean" },
        reasonCode: nullableReasonCodeSchema,
        latest: nullable(miningClaimSchema),
      },
      "Decision 0123: executable is true only when an approved parameter version is in force, at least one hour is settled, claimable > 0 and ≥ the minimum, no claim is submitting / confirming, and the claim path is configured. Otherwise reasonCode, first match: MINING_SETTLEMENT_UNAVAILABLE, MINING_PARAMETERS_PENDING, MINING_NOTHING_SETTLED, MINING_CLAIM_NOTHING_TO_CLAIM, MINING_CLAIM_BELOW_MINIMUM, MINING_CLAIM_IN_FLIGHT, then the configuration reasons (MINING_CLAIM_MAINNET_CLOSED, MINING_CLAIM_CONTRACT_NOT_CONFIGURED, MINING_CLAIM_CHAIN_NOT_CONFIGURED, MINING_CLAIM_SIGNER_NOT_CONFIGURED, MINING_CLAIM_WRITES_DISABLED).",
    ),
  },
  "Decision 0116 hourly settlement block. awaiting_first_settlement: no hour settled yet (show 首个小时结算后开始展示奖励, no growth). displaying: inside the hour after lastHour. settling: that hour is over and the next is not settled yet (show the full previous total). unavailable: the store is down (reasonCode).",
);

const rewardEpochItemSchema = object({
  epochId: opaqueIdSchema,
  hourStart: dateTimeSchema,
  hourEnd: dateTimeSchema,
  nftSelfPower: powerSchema,
  nftReferralPower: powerSchema,
  nftTotalPower: powerSchema,
  assetSelfPower: powerSchema,
  assetReferralPower: powerSchema,
  assetTotalPower: powerSchema,
  nftRewardRaw: rawSchema,
  assetRewardRaw: rawSchema,
  totalRewardRaw: rawSchema,
});

export const miningRewardEpochsResourceSchema = {
  ...object({
    items: { type: "array", maxItems: 24, items: rewardEpochItemSchema },
    nextCursor: nullableCursorSchema,
    decimals: { type: "integer", const: 18 },
    contractVersion: contractVersionSchema,
  }),
  headers: noStoreResponseHeaders(),
} as const;

export const miningClaimsResourceSchema = {
  ...object({
    items: { type: "array", maxItems: 20, items: miningClaimSchema },
    nextCursor: nullableCursorSchema,
    decimals: { type: "integer", const: 18 },
    contractVersion: contractVersionSchema,
  }),
  headers: noStoreResponseHeaders(),
} as const;

export const miningCursorQuerySchema = {
  type: "object",
  additionalProperties: false,
  properties: { cursor: cursorSchema },
} as const;

export const miningClaimPrepareRequestSchema = {
  type: "object",
  additionalProperties: false,
  required: ["walletId"],
  properties: { walletId: opaqueIdSchema },
} as const;

export const miningClaimReportRequestSchema = {
  type: "object",
  additionalProperties: false,
  required: ["claimId", "transactionHash"],
  properties: {
    claimId: opaqueIdSchema,
    transactionHash: {
      ...txHashSchema,
      description: "The hash eth_sendTransaction returned on the device.",
    },
  },
} as const;

export const miningClaimPrepareResourceSchema = {
  ...object({
    claim: miningClaimSchema,
    intent: object({
      calldata: object({
        to: addressSchema,
        data: { type: "string", pattern: "^0x[0-9a-f]*$" },
        value: { type: "string", const: "0" },
      }),
      unsignedTransaction: object(
        {
          chainId: { type: "integer", enum: [56, 97] },
          to: addressSchema,
          data: { type: "string", pattern: "^0x[0-9a-f]*$" },
          value: { type: "string", const: "0x0" },
          from: addressSchema,
          gas: hexQuantitySchema,
          nonce: hexQuantitySchema,
          type: { type: "string", enum: ["eip1559", "legacy"] },
          maxFeePerGas: nullable(hexQuantitySchema),
          maxPriorityFeePerGas: nullable(hexQuantitySchema),
          gasPrice: nullable(hexQuantitySchema),
        },
        "Decision 0123: exactly these eleven keys (no others). The exact JSON-RPC transaction the device passes to Privy eth_sendTransaction; the client must not alter any field. Fee keys follow `type`: eip1559 → maxFeePerGas and maxPriorityFeePerGas set, gasPrice null; legacy → gasPrice set, the two max* null.",
      ),
      payloadDigest: {
        type: "string",
        pattern: "^0x[0-9a-f]{64}$",
        description:
          "Decision 0123: keccak-256 over the UTF-8 bytes of the canonical JSON of unsignedTransaction (object keys sorted by code unit, no whitespace, chainId as a JSON number, null values kept), 0x + 64 lowercase hex. The client recomputes it from the unsignedTransaction it will pass to the wallet and refuses to sign on mismatch.",
      },
      signing: object({
        mode: { type: "string", const: "device_eth_send_transaction" },
        allowed: { type: "boolean" },
        reasonCode: nullableReasonCodeSchema,
      }),
    }),
    decimals: { type: "integer", const: 18 },
    contractVersion: contractVersionSchema,
  }),
  headers: noStoreResponseHeaders(),
} as const;

export const miningClaimReportResourceSchema = {
  ...object({
    claim: miningClaimSchema,
    decimals: { type: "integer", const: 18 },
    contractVersion: contractVersionSchema,
  }),
  headers: noStoreResponseHeaders(),
} as const;

export const miningRewardsReadErrors = {
  400: v2ErrorResponseSchema(["INVALID_REQUEST"]),
  401: v2ErrorResponseSchema(["AUTH_REQUIRED", "AUTH_INVALID"], {
    includeBearerChallenge: true,
  }),
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

export const miningClaimCommandErrors = {
  ...miningRewardsReadErrors,
  403: v2ErrorResponseSchema(["PERMISSION_DENIED", "POLICY_BLOCKED"]),
  404: v2ErrorResponseSchema(["NOT_FOUND"]),
  409: v2ErrorResponseSchema([
    "ACCOUNT_BOOTSTRAP_REQUIRED",
    "DATA_STALE",
    "IDEMPOTENCY_CONFLICT",
    "INSUFFICIENT_BALANCE",
    "RESOURCE_CONFLICT",
    "SIMULATION_FAILED",
    "VERSION_CONFLICT",
  ]),
  422: v2ErrorResponseSchema(["VALIDATION_FAILED"]),
  429: v2ErrorResponseSchema(["RATE_LIMITED"]),
} as const;
